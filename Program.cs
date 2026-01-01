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
            DescriptionHtml = wi.GetString("System.Description"),
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





// -------------------- Atanacak Maddeler (Assignments) --------------------
app.MapGet("/api/assignments/items", async (AzdoClient az, int? top, CancellationToken ct) =>
{
    static string EscapeWiql(string s) => (s ?? "").Replace("'", "''");

    try
    {

    var take = Math.Clamp(top ?? 400, 1, 2000);
    var projRaw = (az.Options.Project ?? "").Trim();
    var proj = EscapeWiql(projRaw);
    var projectClause = string.IsNullOrWhiteSpace(projRaw)
        ? "" // project empty => query across org scope
        : $"    [System.TeamProject] = '{proj}'\n    AND ";

    // Only:
    // - Bug / Product Backlog Item with State=Approved (or TR equivalents)
    // - User Story with State=New (or TR equivalents)
    var wiql = $@"
SELECT [System.Id]
FROM WorkItems
WHERE
{projectClause}    [System.State] <> 'Removed'
    AND (
        ([System.WorkItemType] IN ('Bug','Product Backlog Item') AND [System.State] IN ('Approved','Onaylandı','Onaylandi'))
        OR
        ([System.WorkItemType] = 'User Story' AND [System.State] IN ('New','Yeni'))
    )
ORDER BY [System.ChangedDate] DESC";

    var ids = await az.QueryWorkItemIdsByWiqlAsync(wiql, ct);
    ids = ids.Take(take).ToList();

    var fetched = new List<AzdoWorkItem>();
    foreach (var chunk in ids.Chunk(200))
    {
        var batch = await az.GetWorkItemsBatchAsync(chunk, ct, extraFields: new[]{"System.Description"});
        fetched.AddRange(batch);
    }

    // Preserve WIQL order
    var byId = fetched.ToDictionary(x => x.Id, x => x);
    var list = new List<AssignableItemDto>();

    for (var i = 0; i < ids.Count; i++)
    {
        var id = ids[i];
        if (!byId.TryGetValue(id, out var wi)) continue;

        var type = wi.GetString("System.WorkItemType") ?? "";
        var state = wi.GetString("System.State") ?? "";

        // Priority (for columns)
        int? priority = null;
        var priVal = wi.GetDouble("Microsoft.VSTS.Common.Priority");
        if (priVal is not null)
        {
            var p = (int)Math.Round(priVal.Value);
            priority = p;
        }

        // Some processes don't set Priority on PBIs; keep them visible by defaulting to 4.
        if (priority is null
            && type.Equals("Product Backlog Item", StringComparison.OrdinalIgnoreCase))
        {
            priority = 4;
        }

        if (priority is not null)
        {
            if (priority < 1) priority = 1;
            if (priority > 4) priority = 4;
        }

        // Relevance: prefer StackRank/BacklogPriority, fallback to Priority
        double? relevance = null;
        foreach (var rf in new[] { "Microsoft.VSTS.Common.StackRank", "Microsoft.VSTS.Common.BacklogPriority" })
        {
            relevance = wi.GetDouble(rf);
            if (relevance is not null) break;
        }
        relevance ??= priVal;

        // Tag list
        var tagsRaw = wi.GetString("System.Tags") ?? "";
        var tags = tagsRaw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        // Filter: Bug/PBI must land into a column (1..4)
        static bool IsApprovedState(string s)
            => s.Equals("Approved", StringComparison.OrdinalIgnoreCase)
               || s.Equals("Onaylandı", StringComparison.OrdinalIgnoreCase)
               || s.Equals("Onaylandi", StringComparison.OrdinalIgnoreCase);

        static bool IsNewState(string s)
            => s.Equals("New", StringComparison.OrdinalIgnoreCase)
               || s.Equals("Yeni", StringComparison.OrdinalIgnoreCase);

        if (type.Equals("Bug", StringComparison.OrdinalIgnoreCase)
            || type.Equals("Product Backlog Item", StringComparison.OrdinalIgnoreCase))
        {
            if (priority is null || priority < 1 || priority > 4) continue;
            if (!IsApprovedState(state)) continue;
        }

        if (type.Equals("User Story", StringComparison.OrdinalIgnoreCase))
        {
            if (!IsNewState(state)) continue;
        }

        var assigned = wi.GetIdentity("System.AssignedTo");

        list.Add(new AssignableItemDto
        {
            OrderIndex = i,
            Id = wi.Id,
            Title = wi.GetString("System.Title"),
            DescriptionHtml = wi.GetString("System.Description"),
            WorkItemType = type,
            State = state,
            Priority = priority,
            Relevance = relevance,
            AssignedToDisplayName = assigned?.DisplayName,
            AssignedToUniqueName = assigned?.UniqueName,
            CreatedDate = wi.GetDate("System.CreatedDate") ?? DateTimeOffset.MinValue,
            ChangedDate = wi.GetDate("System.ChangedDate") ?? DateTimeOffset.MinValue,
            DueDate = wi.GetDate("Microsoft.VSTS.Scheduling.DueDate"),
            Tags = tags
        });
    }

    return Results.Ok(list);
    }
    catch (Exception ex)
    {
        var msg = ex.Message;
        if (msg.Length > 1200) msg = msg[..1200];
        return Results.Json(new { message = msg }, statusCode: 502);
    }
});



// -------------------- Kişisel Bazlı Performans --------------------

app.MapMethods("/api/assignments/{id:int}/assignee", new[] { "PATCH" }, async (int id, AssignAssigneeRequest req, AzdoClient az, CancellationToken ct) =>
{
    try
    {
        await az.UpdateWorkItemAssignedToAsync(id, req.AssigneeUniqueName, ct);
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});



/* -------------------- Atanacak Maddeler: Inline Güncelleme & Yeni Madde -------------------- */

static string NormalizeHtmlFromInput(string? input)
{
    var s = (input ?? "").Trim();
    if (string.IsNullOrWhiteSpace(s)) return "";
    // If it looks like HTML, keep it; otherwise encode as HTML and keep newlines.
    if (s.Contains('<') && s.Contains('>')) return s;
    var enc = WebUtility.HtmlEncode(s);
    return enc.Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", "<br/>");
}

app.MapMethods("/api/assignments/{id:int}/assignee", new[] { "PATCH", "POST" }, async (AzdoClient az, int id, UpdateAssigneeRequest req, CancellationToken ct) =>
{
    try
    {
        await az.UpdateWorkItemAssignedToAsync(id, req.AssigneeUniqueName ?? "", ct);
        return Results.Ok(new { ok = true, id });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message, statusCode: 500);
    }
});

app.MapMethods("/api/workitems/{id:int}/description", new[] { "PATCH", "POST" }, async (AzdoClient az, int id, UpdateDescriptionRequest req, CancellationToken ct) =>
{
    try
    {
        var html = NormalizeHtmlFromInput(req.Description);
        await az.UpdateWorkItemDescriptionAsync(id, html, ct);
        return Results.Ok(new { ok = true, id });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message, statusCode: 500);
    }
});

app.MapPost("/api/workitems", async (AzdoClient az, CreateWorkItemRequest req, CancellationToken ct) =>
{
    try
    {
        var type = (req.WorkItemType ?? "").Trim();
        if (!type.Equals("Bug", StringComparison.OrdinalIgnoreCase) &&
            !type.Equals("Product Backlog Item", StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { message = "WorkItemType sadece 'Bug' veya 'Product Backlog Item' olabilir." });

        var title = (req.Title ?? "").Trim();
        if (string.IsNullOrWhiteSpace(title))
            return Results.BadRequest(new { message = "Title boş olamaz." });

        var html = NormalizeHtmlFromInput(req.Description);
        var pri = req.Priority is null ? 4 : Math.Clamp(req.Priority.Value, 1, 4);

        var created = await az.CreateWorkItemAsync(type, title, html, pri, ct);
        return Results.Ok(new { ok = true, id = created.Id });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message, statusCode: 500);
    }
});

app.MapGet("/api/performance/summary", async (AzdoClient az, string users, int year, int month, string? week, int? top, CancellationToken ct) =>
{
    static string EscapeWiql(string s) => (s ?? "").Replace("'", "''");

    try
    {
        var take = Math.Clamp(top ?? 1200, 1, 5000);


// period range (year/month/week)
var w = (week ?? "all").Trim().ToLowerInvariant();
var isAll = w == "" || w == "all" || w == "hepsi";

var mStart = new DateTime(year, month, 1);
var daysInMonth = DateTime.DaysInMonth(year, month);

DateTime start = mStart;
DateTime endExclusive = mStart.AddMonths(1);

if (!isAll)
{
    if (!int.TryParse(w, out var wn)) wn = 1;
    if (wn < 1) wn = 1;
    if (wn > 5) wn = 5;

    var startDay = 1 + (wn - 1) * 7;
    if (startDay > daysInMonth) startDay = Math.Max(1, daysInMonth - 6);

    var endDay = Math.Min(startDay + 6, daysInMonth);

    start = new DateTime(year, month, startDay);
    endExclusive = new DateTime(year, month, endDay).AddDays(1);
}

var sinceStr = start.ToString("yyyy-MM-dd");
var untilStr = endExclusive.ToString("yyyy-MM-dd");

        var projRaw = (az.Options.Project ?? "").Trim();
        var proj = EscapeWiql(projRaw);
        var projectClause = string.IsNullOrWhiteSpace(projRaw)
            ? ""
            : $"[System.TeamProject] = '{proj}' AND ";

        var listUsers = (users ?? "")
            .Split(new[] { ',', ';', '|' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        List<AzdoUserDto> graphUsers;
        try { graphUsers = await az.GetAzdoUsersAsync(2000, ct); }
        catch { graphUsers = new List<AzdoUserDto>(); }

        var userDisplayMap = graphUsers
	        .Where(x => !string.IsNullOrWhiteSpace(x.UniqueName))
	        .GroupBy(x => x.UniqueName!.Trim(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.FirstOrDefault()?.DisplayName?.Trim() ?? "", StringComparer.OrdinalIgnoreCase);

        if (listUsers.Length == 0)
            return Results.Ok(Array.Empty<UserPerfSummaryDto>());

        // Done / InProgress state sets (includes TR-ish fallbacks)
        var doneStates = new HashSet<string>(
            (az.Options.DoneStates ?? Array.Empty<string>())
                .Concat(new[] { "Done", "Closed", "Resolved", "Tamamlandı", "Tamamlandi", "Kapalı", "Kapali", "Çözüldü", "Cozuldu", "Bitti" })
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim()),
            StringComparer.OrdinalIgnoreCase);

        bool IsDone(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return false;
            if (doneStates.Contains(s.Trim())) return true;
            var ss = s.Trim().ToLowerInvariant();
            return ss.Contains("done") || ss.Contains("closed") || ss.Contains("resolved") || ss.Contains("tamam") || ss.Contains("bitti");
        }

        bool IsInProgress(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return false;
            var ss = s.Trim().ToLowerInvariant();
            return ss.Contains("progress") || ss == "active" || ss == "in progress" || ss.Contains("develop") || ss.Contains("geliştir");
        }

        var result = new List<UserPerfSummaryDto>();

        foreach (var uRaw in listUsers)
        {
            var u = uRaw.Trim();
            var uEsc = EscapeWiql(u);

            var assignedClause = uEsc.Contains("@")
                ? $"([System.AssignedTo] CONTAINS '{uEsc}' OR [System.AssignedTo] = '{uEsc}')"
                : $"[System.AssignedTo] = '{uEsc}'";


            var wiql = $@"
SELECT [System.Id]
FROM WorkItems
WHERE
    {projectClause}[System.State] <> 'Removed'
    AND {assignedClause}
    AND [System.WorkItemType] IN ('User Story','Bug','Product Backlog Item')
    AND [System.ChangedDate] >= '{sinceStr}'
    AND [System.ChangedDate] < '{untilStr}'
ORDER BY [System.ChangedDate] DESC";

            var ids = await az.QueryWorkItemIdsByWiqlAsync(wiql, ct);
            ids = ids.Take(take).ToList();

            var fetched = new List<AzdoWorkItem>();
            foreach (var chunk in ids.Chunk(200))
            {
                var batch = await az.GetWorkItemsBatchAsync(chunk, ct);
                fetched.AddRange(batch);
            }

            // "Todos" burada Task değil; Product Backlog Item'ların To-Do tarafı olarak kullanılıyor.
            int stories = 0, bugs = 0, todos = 0, inProgress = 0, done = 0;

            // Prefer Graph display name if we can resolve it by uniqueName (usually email)
            userDisplayMap.TryGetValue(u, out var dnFromGraph);
            string? displayName = string.IsNullOrWhiteSpace(dnFromGraph) ? null : dnFromGraph;

            foreach (var wi in fetched)
            {
                var type = (wi.GetString("System.WorkItemType") ?? "").Trim();
                var state = (wi.GetString("System.State") ?? "").Trim();

                var isStory = type.Equals("User Story", StringComparison.OrdinalIgnoreCase);
                var isBug = type.Equals("Bug", StringComparison.OrdinalIgnoreCase);
                var isPbi = type.Equals("Product Backlog Item", StringComparison.OrdinalIgnoreCase);

                if (isStory) stories++;
                else if (isBug) bugs++;

                if (IsDone(state))
                {
                    done++;
                }
                else if (IsInProgress(state))
                {
                    inProgress++;
                }
                else
                {
                    // To Do sütunu sadece PBI'ları sayar
                    if (isPbi) todos++;
                }

                if (displayName is null)
                {
                    var assigned = wi.GetIdentity("System.AssignedTo");
                    displayName = assigned?.DisplayName;
                }
            }

            if (string.IsNullOrWhiteSpace(displayName) && !string.IsNullOrWhiteSpace(dnFromGraph))
                displayName = dnFromGraph;

            result.Add(new UserPerfSummaryDto
            {
                User = u,
                DisplayName = displayName,
                Stories = stories,
                Bugs = bugs,
                Todos = todos,
                InProgress = inProgress,
                Done = done
            });
        }

        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        var msg = ex.Message;
        if (msg.Length > 1200) msg = msg[..1200];
        return Results.Json(new { message = msg }, statusCode: 502);
    }
});

app.MapGet("/api/performance/done", async (AzdoClient az, string user, int year, int month, string? week, int? top, CancellationToken ct) =>
{
    static string EscapeWiql(string s) => (s ?? "").Replace("'", "''");

    try
    {
        var uRaw = (user ?? "").Trim();
        if (string.IsNullOrWhiteSpace(uRaw))
            return Results.BadRequest(new { message = "user boş olamaz." });

        var take = Math.Clamp(top ?? 2000, 1, 10000);

        // date range: month or week-in-month (1..5). week=all => month
        var daysInMonth = DateTime.DaysInMonth(year, month);
        var mStart = new DateTime(year, month, 1);

        var w = (week ?? "all").Trim().ToLowerInvariant();
        var isAll = w == "" || w == "all" || w == "hepsi";

        DateTime start = mStart;
        DateTime endExclusive = mStart.AddMonths(1);

        if (!isAll)
        {
            if (!int.TryParse(w, out var wn)) wn = 1;
            if (wn < 1) wn = 1;
            if (wn > 5) wn = 5;

            var startDay = 1 + (wn - 1) * 7;
            if (startDay > daysInMonth) startDay = Math.Max(1, daysInMonth - 6);

            var endDay = Math.Min(startDay + 6, daysInMonth);

            start = new DateTime(year, month, startDay);
            endExclusive = new DateTime(year, month, endDay).AddDays(1);
        }

        var sinceStr = start.ToString("yyyy-MM-dd");
        var untilStr = endExclusive.ToString("yyyy-MM-dd");

        var projRaw = (az.Options.Project ?? "").Trim();
        var proj = EscapeWiql(projRaw);
        var projectClause = string.IsNullOrWhiteSpace(projRaw)
            ? ""
            : $"[System.TeamProject] = '{proj}' AND ";

        var doneStates = (az.Options.DoneStates ?? Array.Empty<string>())
            .Concat(new[] { "Done", "Closed", "Resolved", "Tamamlandı", "Tamamlandi", "Kapalı", "Kapali", "Çözüldü", "Cozuldu", "Bitti" })
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => $"'{EscapeWiql(x.Trim())}'")
            .Distinct()
            .ToArray();

        var doneIn = string.Join(",", doneStates);

        var uEsc = EscapeWiql(uRaw);

        List<AzdoUserDto> graphUsers;
        try { graphUsers = await az.GetAzdoUsersAsync(2000, ct); }
        catch { graphUsers = new List<AzdoUserDto>(); }

        var userDisplayMap = graphUsers
	        .Where(x => !string.IsNullOrWhiteSpace(x.UniqueName))
	        .GroupBy(x => x.UniqueName!.Trim(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.FirstOrDefault()?.DisplayName?.Trim() ?? "", StringComparer.OrdinalIgnoreCase);

        var assignedClause = uEsc.Contains("@")
            ? $"([System.AssignedTo] CONTAINS '{uEsc}' OR [System.AssignedTo] = '{uEsc}')"
            : $"[System.AssignedTo] = '{uEsc}'";


        var wiql = $@"
SELECT [System.Id]
FROM WorkItems
WHERE
    {projectClause}[System.State] <> 'Removed'
    AND {assignedClause}
    AND [System.WorkItemType] IN ('Bug','Product Backlog Item')
    AND [System.State] IN ({doneIn})
    AND [System.ChangedDate] >= '{sinceStr}'
    AND [System.ChangedDate] < '{untilStr}'
ORDER BY [System.ChangedDate] ASC";

        var ids = await az.QueryWorkItemIdsByWiqlAsync(wiql, ct);
        ids = ids.Take(take).ToList();

        // extra fields for effort / dates
        var extra = new[]
        {
            "Microsoft.VSTS.Scheduling.StartDate",
            "Microsoft.VSTS.Scheduling.DueDate",
            "Microsoft.VSTS.Scheduling.TargetDate",
            "Microsoft.VSTS.Common.ClosedDate",
            "Microsoft.VSTS.Common.ResolvedDate",
            "Microsoft.VSTS.Scheduling.Effort",
            "Microsoft.VSTS.Scheduling.StoryPoints",
            "Microsoft.VSTS.Scheduling.CompletedWork",
            "Microsoft.VSTS.Scheduling.OriginalEstimate"
        };

        var fetched = new List<AzdoWorkItem>();
        foreach (var chunk in ids.Chunk(200))
        {
            var batch = await az.GetWorkItemsBatchAsync(chunk, ct, extra);
            fetched.AddRange(batch);
        }

        // TZ: Europe/Istanbul if available
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul"); }
        catch { tz = TimeZoneInfo.Utc; }

        static double? PickEffort(AzdoWorkItem wi)
        {
            foreach (var f in new[]
            {
                "Microsoft.VSTS.Scheduling.Effort",
                "Microsoft.VSTS.Scheduling.StoryPoints",
                "Microsoft.VSTS.Scheduling.CompletedWork",
                "Microsoft.VSTS.Scheduling.OriginalEstimate"
            })
            {
                var v = wi.GetDouble(f);
                if (v is not null) return v;
            }
            return null;
        }

        static DateTimeOffset? PickDate(AzdoWorkItem wi, params string[] fields)
        {
            foreach (var f in fields)
            {
                var d = wi.GetDate(f);
                if (d is not null && d.Value > DateTimeOffset.MinValue) return d;
            }
            return null;
        }

        var byId = fetched.ToDictionary(x => x.Id, x => x);
        var items = new List<PerfDoneItemDto>();

        // Filter by *completed date* in selected local period (not changed date).
        // This avoids odd ordering/empty gaps when work items were edited later.
        var startLocalDate = start.Date;
        var endLocalDateEx = endExclusive.Date;

        foreach (var id in ids)
        {
            if (!byId.TryGetValue(id, out var wi)) continue;

            var effort = PickEffort(wi);
            var startDate = PickDate(wi, "Microsoft.VSTS.Scheduling.StartDate");
            var dueDate = PickDate(wi, az.Options.DueDateField, "Microsoft.VSTS.Scheduling.DueDate", "Microsoft.VSTS.Scheduling.TargetDate");
            var closedOrResolved = PickDate(wi, "Microsoft.VSTS.Common.ClosedDate", "Microsoft.VSTS.Common.ResolvedDate");
            var completed = closedOrResolved ?? wi.GetDate("System.ChangedDate") ?? DateTimeOffset.UtcNow;

            // Convert to local date for period filter
            var utc = completed.UtcDateTime;
            var localDate = TimeZoneInfo.ConvertTimeFromUtc(utc, tz).Date;
            if (localDate < startLocalDate || localDate >= endLocalDateEx)
                continue;

            items.Add(new PerfDoneItemDto
            {
                Id = wi.Id,
                Title = wi.GetString("System.Title"),
                WorkItemType = wi.GetString("System.WorkItemType"),
                State = wi.GetString("System.State"),
                Effort = effort,
                StartDate = startDate,
                DueDate = dueDate,
                CompletedDate = completed
            });
        }

        // Sort by completed date asc (table + chart should match the selected period timeline)
        items = items
            .OrderBy(x => x.CompletedDate ?? DateTimeOffset.MaxValue)
            .ThenBy(x => x.Id)
            .ToList();

        // Build daily candles (continuous range: include days with zero)
        var itemGroups = items
            .GroupBy(x =>
            {
                var utc = (x.CompletedDate ?? DateTimeOffset.UtcNow).UtcDateTime;
                return TimeZoneInfo.ConvertTimeFromUtc(utc, tz).Date;
            })
            .ToDictionary(g => g.Key, g => g.ToList());

        var candles = new List<PerfCandleDto>();
        for (var day = startLocalDate; day < endLocalDateEx; day = day.AddDays(1))
        {
            if (!itemGroups.TryGetValue(day, out var list))
                list = new List<PerfDoneItemDto>();

            var ordered = list
                .OrderBy(x => (x.CompletedDate ?? DateTimeOffset.UtcNow))
                .ToList();

            double val(PerfDoneItemDto x) => x.Effort ?? 0;

            var open = ordered.Count > 0 ? val(ordered.First()) : 0;
            var close = ordered.Count > 0 ? val(ordered.Last()) : 0;
            var high = ordered.Count > 0 ? ordered.Max(x => val(x)) : 0;
            var low = ordered.Count > 0 ? ordered.Min(x => val(x)) : 0;

            candles.Add(new PerfCandleDto
            {
                Date = day.ToString("yyyy-MM-dd"),
                Open = open,
                High = high,
                Low = low,
                Close = close,
                Items = ordered.Select(x => new PerfCandleItemDto { Id = x.Id, Effort = x.Effort ?? 0 }).ToArray()
            });
        }

        return Results.Ok(new { items, candles });
    }
    catch (Exception ex)
    {
        var msg = ex.Message;
        if (msg.Length > 1200) msg = msg[..1200];
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
    public string? DescriptionHtml { get; set; }
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



public sealed class AssignableItemDto
{
    // Preserves the WIQL order (used for "default" sorting)
    public int OrderIndex { get; set; }

    public int Id { get; set; }
    public string? Title { get; set; }
    public string? DescriptionHtml { get; set; }
    public string? WorkItemType { get; set; }
    public string? State { get; set; }

    public int? Priority { get; set; }
    public double? Relevance { get; set; }

    public string? AssignedToDisplayName { get; set; }
    public string? AssignedToUniqueName { get; set; }

    public DateTimeOffset CreatedDate { get; set; }
    public DateTimeOffset ChangedDate { get; set; }

    public DateTimeOffset? DueDate { get; set; }

    public string[] Tags { get; set; } = Array.Empty<string>();
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

// -------------------- Performance DTOs --------------------
public sealed class UserPerfSummaryDto
{
    public string User { get; set; } = ""; // UniqueName (email-like)
    public string? DisplayName { get; set; }

    public int Stories { get; set; }
    public int Bugs { get; set; }
    public int Todos { get; set; }
    public int InProgress { get; set; }
    public int Done { get; set; }
}

public sealed class PerfDoneItemDto
{
    public int Id { get; set; }
    public string? Title { get; set; }
    public string? WorkItemType { get; set; }
    public string? State { get; set; }
    public double? Effort { get; set; }
    public DateTimeOffset? StartDate { get; set; }
    public DateTimeOffset? DueDate { get; set; }
    public DateTimeOffset? CompletedDate { get; set; }
}

public sealed class PerfCandleItemDto
{
    public int Id { get; set; }
    public double Effort { get; set; }
}

public sealed class PerfCandleDto
{
    // yyyy-MM-dd
    public string Date { get; set; } = "";
    public double Open { get; set; }
    public double High { get; set; }
    public double Low { get; set; }
    public double Close { get; set; }

    public PerfCandleItemDto[] Items { get; set; } = Array.Empty<PerfCandleItemDto>();
}


public sealed class AssignAssigneeRequest
{
    // Empty / null => Unassigned
    public string? AssigneeUniqueName { get; set; }
}



public sealed class UpdateAssigneeRequest
{
    public string? AssigneeUniqueName { get; set; }
}

public sealed class UpdateDescriptionRequest
{
    public string? Description { get; set; }
}

public sealed class CreateWorkItemRequest
{
    public string? WorkItemType { get; set; } // "Bug" | "Product Backlog Item"
    public string? Title { get; set; }
    public string? Description { get; set; } // plain text or html
    public int? Priority { get; set; } // 1..4
}

