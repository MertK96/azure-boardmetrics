using AzdoBoardMetrics.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AzdoBoardMetrics.Services;

public class CollectorHostedService : BackgroundService
{
    private readonly IServiceProvider _sp;
    private readonly ILogger<CollectorHostedService> _log;
    private readonly TimeSpan _interval = TimeSpan.FromMinutes(10);

    public CollectorHostedService(IServiceProvider sp, ILogger<CollectorHostedService> log)
    {
        _sp = sp;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _log.LogInformation("Collector started.");

        // Small startup delay
        await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
try
{
    await CollectOnce(stoppingToken);
}
catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
{
    // Uygulama kapanırken beklenen durum; error loglama.
}
catch (TaskCanceledException) when (stoppingToken.IsCancellationRequested)
{
    // Aynı şekilde: HTTP çağrıları iptal olur, normal.
}
catch (Exception ex)
{
    _log.LogError(ex, "Collector error.");
}


            await Task.Delay(_interval, stoppingToken);
        }
    }

    private async Task CollectOnce(CancellationToken ct)
    {
        using var scope = _sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var az = scope.ServiceProvider.GetRequiredService<AzdoClient>();
        var metrics = scope.ServiceProvider.GetRequiredService<MetricsService>();
        var opt = az.Options;
        var allowedUsers = (opt.Users ?? Array.Empty<string>())
    .Where(x => !string.IsNullOrWhiteSpace(x))
    .Select(x => x.Trim().ToLowerInvariant())
    .ToHashSet();

        if (string.IsNullOrWhiteSpace(opt.OrganizationUrl) || string.IsNullOrWhiteSpace(opt.Project) || string.IsNullOrWhiteSpace(opt.Pat))
        {
            _log.LogWarning("Azure DevOps config missing. Set Azdo:OrganizationUrl/Project/Pat (or env AZDO_ORG_URL, AZDO_PROJECT, AZDO_PAT).");
            return;
        }

        var since = await GetSinceAsync(db, ct);
        _log.LogInformation("Collecting work items changed since {Since} (UTC)", since);

        var ids = await az.QueryWorkItemIdsAsync(since, ct);

        // since değerini "işlenenlerin max ChangedDate" ile ilerleteceğiz
        var maxChangedSeen = since;

        int upsertedCount = 0;

        // Chunk by 200
foreach (var chunk in ids.Chunk(200))
{
    var items = await az.GetWorkItemsBatchAsync(chunk, ct);

    foreach (var wi in items)
    {
        // AllowedUsers boşsa filtreleme yapma (tümünü al)
        if (allowedUsers.Count > 0)
        {
            var ident = wi.GetIdentity("System.AssignedTo");
            var unique = (ident?.UniqueName ?? ident?.DisplayName ?? "").Trim().ToLowerInvariant();

            if (string.IsNullOrWhiteSpace(unique) || !allowedUsers.Contains(unique))
                continue;
        }

        await UpsertWorkItemAsync(db, az, metrics, wi, ct);
        upsertedCount++;
    }

    await db.SaveChangesAsync(ct);
}

        // Hiç kayıt işlenmediyse since'i ileri alma (yoksa arada kaçırma riski olur)
        if (upsertedCount > 0)
        {
            // küçük overlap: aynı saniyede gelen edge-case’leri kaçırmamak için
            var newSince = maxChangedSeen.AddMinutes(-1);
            if (newSince < since) newSince = since; // geriye gitmesin
            await SetSinceAsync(db, newSince, ct);

            _log.LogInformation("Collector done. Upserted {Count} work items. sinceUtc -> {NewSince} (UTC)", upsertedCount, newSince);
        }
        else
        {
            _log.LogInformation("Collector done. No new work items after {Since}. sinceUtc unchanged.", since);
        }
    }

    private static async Task<DateTimeOffset> GetSinceAsync(AppDbContext db, CancellationToken ct)
    {
        var kv = await db.Kv.FirstOrDefaultAsync(x => x.Key == "sinceUtc", ct);
        if (kv is null) return DateTimeOffset.UtcNow.AddDays(-14); // initial backfill
        if (DateTimeOffset.TryParse(kv.Value, out var dto)) return dto;
        return DateTimeOffset.UtcNow.AddDays(-14);
    }

    private static async Task SetSinceAsync(AppDbContext db, DateTimeOffset val, CancellationToken ct)
    {
        var kv = await db.Kv.FirstOrDefaultAsync(x => x.Key == "sinceUtc", ct);
        if (kv is null)
        {
            kv = new KvEntity { Key = "sinceUtc", Value = val.UtcDateTime.ToString("O") };
            db.Kv.Add(kv);
        }
        else
        {
            kv.Value = val.UtcDateTime.ToString("O");
        }
        await db.SaveChangesAsync(ct);
    }

   private static async Task UpsertWorkItemAsync(
    AppDbContext db,
    AzdoClient az,
    MetricsService metrics,
    AzdoWorkItem wi,
    CancellationToken ct)
{
    var opt = az.Options;
    var id = wi.Id;

    // WorkItem entity upsert
    var entity = await db.WorkItems.FirstOrDefaultAsync(x => x.Id == id, ct);
    if (entity is null)
    {
        entity = new WorkItemEntity { Id = id };
        db.WorkItems.Add(entity);
    }

    entity.Url = wi.Url;
    entity.Title = wi.GetString("System.Title");
    entity.WorkItemType = wi.GetString("System.WorkItemType");
    entity.State = wi.GetString("System.State");
    entity.IterationPath = wi.GetString("System.IterationPath");
    entity.Tags = wi.GetString("System.Tags");
    entity.BoardColumn = wi.GetString("System.BoardColumn");
    entity.BoardLane = wi.GetString("System.BoardLane");

var ident = wi.GetIdentity("System.AssignedTo");
entity.AssignedToDisplayName = ident?.DisplayName;
entity.AssignedToUniqueName = ident?.UniqueName; // sadece email/unique


    entity.CreatedDate = wi.GetDate("System.CreatedDate") ?? entity.CreatedDate;
    entity.ChangedDate = wi.GetDate("System.ChangedDate") ?? entity.ChangedDate;

    entity.Effort = wi.GetDouble(opt.EffortField);
    entity.DueDate = wi.GetDate(opt.DueDateField);

    // ---- REVISION UPSERT (optimized) ----
    // 1 query: mevcut revleri çek -> dictionary (Rev -> entity)
    var existing = await db.WorkItemRevisions
        .Where(x => x.WorkItemId == id)
        .ToDictionaryAsync(x => x.Rev, ct);

    // Eğer DB'de gördüğümüz en son rev değişim tarihi, WorkItem'in ChangedDate'inden yeni/eşitse,
    // revisions API'yi çağırmadan mevcut revlerle devam edebiliriz.
    // (ChangedDate aynı kaldıysa rev listesi değişmemiş kabulü)
    DateTimeOffset? maxStoredRevChanged = null;
    if (existing.Count > 0)
        maxStoredRevChanged = existing.Values.Max(x => x.ChangedDate);

    var needRefreshRevs =
        maxStoredRevChanged is null ||
        (entity.ChangedDate != default && entity.ChangedDate > maxStoredRevChanged.Value);

    List<AzdoRevision> revs;
    if (needRefreshRevs)
    {
        revs = await az.ListRevisionsAsync(id, ct);

        foreach (var r in revs)
        {
            if (existing.TryGetValue(r.Rev, out var row))
            {
                // update
                row.ChangedDate = r.ChangedDate;
                row.State = r.State;
                row.Effort = r.Effort;
                row.DueDate = r.DueDate;
            }
            else
            {
                // insert
                var newRow = new WorkItemRevisionEntity
                {
                    WorkItemId = id,
                    Rev = r.Rev,
                    ChangedDate = r.ChangedDate,
                    State = r.State,
                    Effort = r.Effort,
                    DueDate = r.DueDate
                };
                db.WorkItemRevisions.Add(newRow);
                existing[r.Rev] = newRow;
            }
        }
    }

    // metrics için revleri tekrar DB'den çekme; dictionary üzerinden ver
    // (OrderBy: metriklerin deterministik olması için)
    var revEntities = existing.Values
        .OrderBy(x => x.Rev)
        .ToList();

    metrics.ApplyMetrics(entity, opt, revEntities);
    metrics.ApplyPoolRules(entity, opt);

    entity.UpdatedAt = DateTimeOffset.UtcNow;
}
}
