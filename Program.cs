using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using AzdoBoardMetrics.Data;
using AzdoBoardMetrics.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;


var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<AzdoOptions>(builder.Configuration.GetSection("Azdo"));
builder.Services.AddHttpClient<AzdoClient>();

// NETLIFY/DEMO için: kalıcı DB yoksa InMemory
builder.Services.AddDbContext<AppDbContext>(opt =>
    opt.UseInMemoryDatabase("azdo_metrics"));
builder.Services.AddSingleton<MetricsService>();
builder.Services.AddHostedService<CollectorHostedService>();

var app = builder.Build();

// InMemory için de sorun değil
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
}

app.UseDefaultFiles();
app.UseStaticFiles();

// -------------------- In-memory "resolved" store --------------------
// FeedbackId => (IsResolved, ResolvedAt)
var resolutions = new ConcurrentDictionary<long, ResolutionEntry>();

// ---- API ----
app.MapGet("/api/health", () => Results.Ok(new { ok = true, ts = DateTimeOffset.UtcNow }));

app.MapGet("/api/config", (IConfiguration cfg) =>
{
    var az = cfg.GetSection("Azdo").Get<AzdoOptions>() ?? new();
    az.Pat = "***";
    return Results.Ok(az);
});

app.MapGet("/api/assignees", (IOptions<AzdoOptions> opt) =>
{
    var users = (opt.Value.Users ?? Array.Empty<string>())
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Select(x => x.Trim())
        .Distinct()
        .ToArray();

    return Results.Ok(users);
});

app.MapGet("/api/workitems", async (AppDbContext db, string? assignee, string? flagged, int? top) =>
{
    // SADECE In Progress
    var q = db.WorkItems.AsNoTracking()
        .Where(x => x.State == "In Progress");

    if (!string.IsNullOrWhiteSpace(assignee))
        q = q.Where(x => x.AssignedToUniqueName == assignee);

    if (!string.IsNullOrWhiteSpace(flagged) && flagged.Equals("pool", StringComparison.OrdinalIgnoreCase))
        q = q.Where(x => x.NeedsFeedback);

    var take = Math.Clamp(top ?? 200, 1, 2000);

    // InMemory'de ORDER BY sorun değil; yine de aynı davranış için client-side sıralama bırakıyorum
    var list = await q.Take(5000).ToListAsync();
    var items = list
        .OrderByDescending(x => x.ChangedDate)
        .Select(DtoMapper.ToDto)
        .Take(take)
        .ToList();

    return Results.Ok(items);
});

// Azure DevOps attachment proxy (img src için)
app.MapGet("/api/proxy/attachment", async (AzdoClient az, string url, CancellationToken ct) =>
{
    try
    {
        var imageBytes = await az.GetAttachmentAsync(url, ct);
        return Results.File(imageBytes, "image/png");
    }
    catch
    {
        return Results.NotFound();
    }
});

app.MapGet("/api/workitems/{id:int}", async (AppDbContext db, AzdoClient az, int id, CancellationToken ct) =>
{
    var wi = await db.WorkItems.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
    if (wi is null) return Results.NotFound();

    if (!string.Equals(wi.State, "In Progress", StringComparison.OrdinalIgnoreCase))
        return Results.NotFound();

    var feedbackRaw = await db.Feedback.AsNoTracking()
        .Where(f => f.WorkItemId == id)
        .Take(500)
        .ToListAsync(ct);

    var feedback = feedbackRaw
        .OrderByDescending(f => f.CreatedAt)
        .Take(100)
        .ToList();

    // Work item açıklaması (HTML) - mümkünse
    string? descriptionHtml = null;
    try
    {
        descriptionHtml = await az.GetWorkItemDescriptionHtmlAsync(id, wi.WorkItemType, ct);

        // img src'leri proxy'ye yönlendir
        if (!string.IsNullOrWhiteSpace(descriptionHtml))
        {
            var pattern = @"<img\s+[^>]*src\s*=\s*['""]([^'""]*dev\.azure\.com[^'""]*)['""]([^>]*)>";
            descriptionHtml = Regex.Replace(
                descriptionHtml,
                pattern,
                match =>
                {
                    var originalSrc = match.Groups[1].Value;
                    var encodedSrc = Uri.EscapeDataString(originalSrc);
                    var restOfTag = match.Groups[2].Value;
                    return $"<img src=\"/api/proxy/attachment?url={encodedSrc}\"{restOfTag}>";
                },
                RegexOptions.IgnoreCase);
        }
    }
    catch
    {
        // açıklama çekilemezse yine de detay endpoint'i çalışsın
    }

    return Results.Ok(new
    {
        workItem = DtoMapper.ToDto(wi),
        feedback,
        descriptionHtml
    });
});

app.MapPost("/api/workitems/{id:int}/feedback", async (AppDbContext db, int id, FeedbackCreate dto) =>
{
    var wi = await db.WorkItems.FirstOrDefaultAsync(x => x.Id == id);
    if (wi is null) return Results.NotFound();

    var note = (dto.Note ?? "").Trim();
    if (string.IsNullOrWhiteSpace(note))
        return Results.BadRequest(new { message = "Not boş olamaz." });

    var createdAt = DateTimeOffset.UtcNow;

    var f = new FeedbackEntity
    {
        WorkItemId = id,
        Category = null,     // kaldırıldı
        Impact = null,       // kaldırıldı
        Note = note,
        CreatedBy = "",      // DB NOT NULL ise boş geçiyoruz (UI'da alan yok)
        CreatedAt = createdAt
    };

    db.Feedback.Add(f);

    // Not girildiyse pool'a al
    wi.NeedsFeedback = true;
    wi.LastFeedbackAt = createdAt;
    wi.PoolReason = note.Length <= 80 ? note : note[..80] + "...";

    await db.SaveChangesAsync();
    return Results.Ok(f);
});

// "Notlar sekmesi" için liste endpoint'i (work item tablosundan ayrı)
app.MapGet("/api/notes", async (AppDbContext db, string? assignee, bool? resolved, int? top) =>
{
    var take = Math.Clamp(top ?? 300, 1, 2000);

    var q = from f in db.Feedback.AsNoTracking()
            join w in db.WorkItems.AsNoTracking() on f.WorkItemId equals w.Id
            where w.State == "In Progress"
            select new { f, w };

    if (!string.IsNullOrWhiteSpace(assignee))
        q = q.Where(x => x.w.AssignedToUniqueName == assignee);

    var raw = await q.Take(5000).ToListAsync();

    var rows = raw
        .OrderByDescending(x => x.f.CreatedAt)
        .Select(x =>
        {
            resolutions.TryGetValue(x.f.Id, out var r);
            var isResolved = r?.IsResolved ?? false;
            var resolvedAt = r?.ResolvedAt;

            return new NoteRow
            {
                FeedbackId = x.f.Id,
                WorkItemId = x.w.Id,
                Title = x.w.Title,
                Assignee = x.w.AssignedToUniqueName ?? x.w.AssignedToDisplayName,
                CreatedAt = x.f.CreatedAt,
                Note = x.f.Note,
                IsResolved = isResolved,
                ResolvedAt = resolvedAt
            };
        });

    if (resolved is true) rows = rows.Where(x => x.IsResolved);
    if (resolved is false) rows = rows.Where(x => !x.IsResolved);

    return Results.Ok(rows.Take(take).ToList());
});

// Checkbox ile resolved işaretleme
app.MapPost("/api/notes/{feedbackId:long}/resolve", (long feedbackId, ResolveDto dto) =>
{
    if (dto.IsResolved)
    {
        resolutions[feedbackId] = new ResolutionEntry(true, DateTimeOffset.UtcNow);
    }
    else
    {
        resolutions[feedbackId] = new ResolutionEntry(false, null);
    }

    return Results.Ok(new { feedbackId, dto.IsResolved });
});

app.Run();

// -------------------- DTOs --------------------
public record FeedbackCreate(string? Note);
public record ResolveDto(bool IsResolved);

public sealed class NoteRow
{
    public long FeedbackId { get; set; }
    public int WorkItemId { get; set; }
    public string? Title { get; set; }
    public string? Assignee { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public string? Note { get; set; }
    public bool IsResolved { get; set; }
    public DateTimeOffset? ResolvedAt { get; set; }
}

public sealed record ResolutionEntry(bool IsResolved, DateTimeOffset? ResolvedAt);

// API'de BoardColumn/BoardLane dönmemek için DTO
public record WorkItemDto
{
    public int Id { get; init; }
    public string? Title { get; init; }
    public string? WorkItemType { get; init; }
    public string? State { get; init; }
    public string? AssignedToDisplayName { get; init; }
    public string? AssignedToUniqueName { get; init; }
    public string? IterationPath { get; init; }
    public string? Tags { get; init; }
    public double? Effort { get; init; }
    public DateTimeOffset? DueDate { get; init; }
    public DateTimeOffset CreatedDate { get; init; }
    public DateTimeOffset ChangedDate { get; init; }
    public DateTimeOffset? StartDate { get; init; }
    public DateTimeOffset? DoneDate { get; init; }
    public DateTimeOffset? DueDateSetDate { get; init; }
    public int? ExpectedDays { get; init; }
    public DateTimeOffset? ForecastDueDate { get; init; }
    public int? CommitmentVarianceDays { get; init; }
    public int? ForecastVarianceDays { get; init; }
    public int? SlackDays { get; init; }
    public int? PlanningLagDays { get; init; }
    public int DueDateChangedCount { get; init; }
    public int TotalDueDateSlipDays { get; init; }
    public bool NeedsFeedback { get; init; }
    public string? PoolReason { get; init; }
    public DateTimeOffset? LastFeedbackAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
}

public static class DtoMapper
{
    public static WorkItemDto ToDto(WorkItemEntity x) => new()
    {
        Id = x.Id,
        Title = x.Title,
        WorkItemType = x.WorkItemType,
        State = x.State,
        AssignedToDisplayName = x.AssignedToDisplayName,
        AssignedToUniqueName = x.AssignedToUniqueName,
        IterationPath = x.IterationPath,
        Tags = x.Tags,
        Effort = x.Effort,
        DueDate = x.DueDate,
        CreatedDate = x.CreatedDate,
        ChangedDate = x.ChangedDate,
        StartDate = x.StartDate,
        DoneDate = x.DoneDate,
        DueDateSetDate = x.DueDateSetDate,
        ExpectedDays = x.ExpectedDays,
        ForecastDueDate = x.ForecastDueDate,
        CommitmentVarianceDays = x.CommitmentVarianceDays,
        ForecastVarianceDays = x.ForecastVarianceDays,
        SlackDays = x.SlackDays,
        PlanningLagDays = x.PlanningLagDays,
        DueDateChangedCount = x.DueDateChangedCount,
        TotalDueDateSlipDays = x.TotalDueDateSlipDays,
        NeedsFeedback = x.NeedsFeedback,
        PoolReason = x.PoolReason,
        LastFeedbackAt = x.LastFeedbackAt,
        UpdatedAt = x.UpdatedAt
    };
}
