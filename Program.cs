using System.Collections.Concurrent;
using System.Net;
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

app.MapGet("/api/azdo/users", async (AzdoClient az, int? top, CancellationToken ct) =>
{
    var take = Math.Clamp(top ?? 300, 1, 2000);
    var users = await az.GetAzdoUsersAsync(take, ct);
    return Results.Ok(users);
});


/* -------------------- Code Review Ataması -------------------- */

// Ready for Code Rewiew kolonundaki maddeleri getir
app.MapGet("/api/code-review/items", async (AzdoClient az, string? assignee, int? top, CancellationToken ct) =>
{
    var take = Math.Clamp(top ?? 200, 1, 2000);
    var col = string.IsNullOrWhiteSpace(az.Options.ReadyForCodeReviewColumn)
        ? "Ready for Code Rewiew"
        : az.Options.ReadyForCodeReviewColumn;

    // Work items in this board column
    var ids = await az.QueryWorkItemIdsByBoardColumnAsync(col, ct);
    ids = ids.Take(take).ToList();

    // Try to resolve Review Owner field reference name (for listing)
    string? reviewOwnerRef = null;
    try { reviewOwnerRef = await az.GetReviewOwnerFieldReferenceNameAsync(ct); } catch { /* ignore */ }

    var extraFields = new List<string>();
    if (!string.IsNullOrWhiteSpace(reviewOwnerRef))
        extraFields.Add(reviewOwnerRef!);

    var items = new List<AzdoWorkItem>();
    foreach (var chunk in ids.Chunk(200))
    {
        var batch = await az.GetWorkItemsBatchAsync(chunk, ct, extraFields);
        items.AddRange(batch);
    }

    var list = new List<CodeReviewItemDto>();

    foreach (var wi in items)
    {
        var assigned = wi.GetIdentity("System.AssignedTo");
        if (!string.IsNullOrWhiteSpace(assignee))
        {
            var a = assignee.Trim().ToLowerInvariant();
            var u = (assigned?.UniqueName ?? "").Trim().ToLowerInvariant();
            if (u != a) continue;
        }

        AzdoIdentity? reviewOwner = null;
        if (!string.IsNullOrWhiteSpace(reviewOwnerRef))
            reviewOwner = wi.GetIdentity(reviewOwnerRef!);

        list.Add(new CodeReviewItemDto
        {
            Id = wi.Id,
            Title = wi.GetString("System.Title"),
            State = wi.GetString("System.State"),
            BoardColumn = wi.GetString("System.BoardColumn"),
            AssignedToDisplayName = assigned?.DisplayName,
            AssignedToUniqueName = assigned?.UniqueName,
            ReviewOwnerDisplayName = reviewOwner?.DisplayName,
            ReviewOwnerUniqueName = reviewOwner?.UniqueName
        });
    }

    // keep original order (ChangedDate desc) roughly by id list order
    var order = ids.Select((id, idx) => new { id, idx }).ToDictionary(x => x.id, x => x.idx);
    var ordered = list.OrderBy(x => order.TryGetValue(x.Id, out var ix) ? ix : int.MaxValue).ToList();

    return Results.Ok(ordered);
});

// Bir maddeye Review Owner ata (Azure DevOps field update)
app.MapPost("/api/code-review/{id:int}/assign", async (AzdoClient az, AppDbContext db, int id, ReviewAssignCreate dto, CancellationToken ct) =>
{
    var reviewerUniqueName = (dto.ReviewerUniqueName ?? "").Trim();
    var reviewerDisplayName = (dto.ReviewerDisplayName ?? "").Trim();

    if (string.IsNullOrWhiteSpace(reviewerUniqueName))
        return Results.BadRequest(new { message = "Review Owner boş olamaz." });

try
    {
        await az.AssignReviewOwnerAsync(id, reviewerUniqueName, reviewerDisplayName, ct);

        db.ReviewAssignments.Add(new ReviewAssignmentEntity
        {
            WorkItemId = id,
            Reviewer = reviewerUniqueName,
            AssignedBy = "", // UI'da kullanıcı bilgisi yok
            Note = (dto.Note ?? "").Trim(),
            CreatedAt = DateTimeOffset.UtcNow
        });

        await db.SaveChangesAsync(ct);

        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        var msg = ex.Message;
        if (msg.Length > 500) msg = msg[..500];
        return Results.Json(new { message = msg }, statusCode: 502);
    }
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

// Azure DevOps iş öğesine yorum (Discussion) ekle
app.MapPost("/api/workitems/{id:int}/comment", async (AzdoClient az, AppDbContext db, int id, CommentCreate dto, CancellationToken ct) =>
{
    // UI kısıtı: sadece In Progress olanları yorumlayalım
    var wi = await db.WorkItems.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
    if (wi is null) return Results.NotFound();
    if (!string.Equals(wi.State, "In Progress", StringComparison.OrdinalIgnoreCase))
        return Results.NotFound();

    var raw = (dto.Text ?? "").Trim();
    if (string.IsNullOrWhiteSpace(raw))
        return Results.BadRequest(new { message = "Yorum boş olamaz." });

    // Azure DevOps UI'nın gönderdiği gibi HTML'e sar (güvenli)
    var encoded = WebUtility.HtmlEncode(raw).Replace("\r\n", "\n").Replace("\n", "<br/>");
    var html = $"<div>{encoded}</div>";

    try
    {
        await az.AddWorkItemCommentHtmlAsync(id, html, ct);
        return Results.Ok(new { ok = true });
    }
    catch (HttpRequestException ex)
    {
        // 401/403/429/500 vs detayını UI'ya kısa mesaj olarak döndür
        var msg = ex.Message;
        if (msg.Length > 500) msg = msg[..500];
        return Results.Json(new { message = msg }, statusCode: 502);
    }
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
public record CommentCreate(string? Text);
public record ResolveDto(bool IsResolved);


public record ReviewAssignCreate(string? ReviewerUniqueName, string? ReviewerDisplayName, string? Note);

public sealed class CodeReviewItemDto
{
    public int Id { get; set; }
    public string? Title { get; set; }
    public string? State { get; set; }
    public string? BoardColumn { get; set; }

    public string? AssignedToDisplayName { get; set; }
    public string? AssignedToUniqueName { get; set; }

    public string? ReviewOwnerDisplayName { get; set; }
    public string? ReviewOwnerUniqueName { get; set; }
}


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
