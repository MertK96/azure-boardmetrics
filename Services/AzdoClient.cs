using Microsoft.Extensions.Options;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace AzdoBoardMetrics.Services;

public class AzdoOptions
{
    public string OrganizationUrl { get; set; } = "";
    public string Project { get; set; } = "";
    public string? Team { get; set; } = "";
    public string Pat { get; set; } = "";
    public string[] Users { get; set; } = Array.Empty<string>();

    public string EffortField { get; set; } = "Microsoft.VSTS.Scheduling.Effort";
    public string DueDateField { get; set; } = "Microsoft.VSTS.Scheduling.TargetDate";
    public string DescriptionField { get; set; } = "Custom.UserStoryProblem";
    public string[] PriorityFields { get; set; } = new[] { "Microsoft.VSTS.Common.Priority", "Microsoft.VSTS.Common.StackRank" };

    public string[] StartStates { get; set; } = new[] { "Active", "In Progress" };
    public string[] DoneStates { get; set; } = new[] { "Done", "Closed", "Resolved" };

    public double WorkdayEffortPerDay { get; set; } = 4.0;
    public string ExpectedDaysRounding { get; set; } = "Ceil"; // Ceil/Floor/Round
    public bool UseBusinessDays { get; set; } = true;

    public PoolRuleOptions PoolRules { get; set; } = new();

    public class PoolRuleOptions
    {
        public int CommitmentLateDaysThreshold { get; set; } = 1;
        public int ForecastLateDaysThreshold { get; set; } = 1;
        public int MaxPlanningLagDays { get; set; } = 2;
        public int MaxCodeReviewWaitDays { get; set; } = 2;
    }
}

public class AzdoClient
{
    private readonly HttpClient _http;
    private readonly AzdoOptions _opt;

    public AzdoClient(HttpClient http, IOptions<AzdoOptions> opt, IConfiguration cfg)
    {
        _http = http;
        _opt = opt.Value;

        // Allow env overrides
        _opt.OrganizationUrl = Environment.GetEnvironmentVariable("AZDO_ORG_URL") ?? _opt.OrganizationUrl;
        _opt.Project = Environment.GetEnvironmentVariable("AZDO_PROJECT") ?? _opt.Project;
        _opt.Pat = Environment.GetEnvironmentVariable("AZDO_PAT") ?? _opt.Pat;

        _http.BaseAddress = new Uri(_opt.OrganizationUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var token = Convert.ToBase64String(Encoding.ASCII.GetBytes($":{_opt.Pat}"));
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", token);
    }

    public AzdoOptions Options => _opt;

    public async Task<List<int>> QueryWorkItemIdsAsync(DateTimeOffset changedSinceUtc, CancellationToken ct)
    {
        // WIQL "date precision" istiyor -> SADECE tarih (YYYY-MM-DD)
        var sinceDate = changedSinceUtc.UtcDateTime.ToString("yyyy-MM-dd");
        var proj = EscapeWiql(_opt.Project);

        var wiql = $@"
SELECT [System.Id]
FROM WorkItems
WHERE
    [System.TeamProject] = '{proj}'
    AND [System.ChangedDate] >= '{sinceDate}'
    AND [System.State] <> 'Removed'
ORDER BY [System.ChangedDate] DESC";

        var path = $"{_opt.Project}/_apis/wit/wiql?api-version=7.1";
        var payload = JsonSerializer.Serialize(new { query = wiql });

        using var res = await _http.PostAsync(
            path,
            new StringContent(payload, Encoding.UTF8, "application/json"),
            ct);

        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            throw new HttpRequestException(
                $"WIQL failed. Status={(int)res.StatusCode} {res.ReasonPhrase}\n\nWIQL:\n{wiql}\n\nBody:\n{body}");
        }

        using var s = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct);

        var ids = new List<int>();
        if (doc.RootElement.TryGetProperty("workItems", out var workItems))
        {
            foreach (var wi in workItems.EnumerateArray())
            {
                if (wi.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var id))
                    ids.Add(id);
            }
        }

        return ids;
    }

    public async Task<List<AzdoWorkItem>> GetWorkItemsBatchAsync(IEnumerable<int> ids, CancellationToken ct)
    {
        var idList = ids?.Distinct().Take(200).ToArray() ?? Array.Empty<int>();
        if (idList.Length == 0) return new List<AzdoWorkItem>();

        // NOT: System.BoardColumn / Lane gibi alanlar her projede yok -> 400 üretebiliyor.
        // Güvenli field seti.
        var fields = new List<string>
        {
            "System.Id",
            "System.Title",
            "System.WorkItemType",
            "System.State",
            "System.AssignedTo",
            "System.CreatedDate",
            "System.ChangedDate",
            "System.IterationPath",
            "System.Tags"
        };

        if (!string.IsNullOrWhiteSpace(_opt.EffortField) && !fields.Contains(_opt.EffortField))
            fields.Add(_opt.EffortField);

        if (!string.IsNullOrWhiteSpace(_opt.DueDateField) && !fields.Contains(_opt.DueDateField))
            fields.Add(_opt.DueDateField);

        if (_opt.PriorityFields is { Length: > 0 })
        {
            foreach (var pf in _opt.PriorityFields)
            {
                if (!string.IsNullOrWhiteSpace(pf) && !fields.Contains(pf))
                    fields.Add(pf);
            }
        }

        var body = JsonSerializer.Serialize(new
        {
            ids = idList,
            fields = fields.ToArray()
        });

        var path = $"{_opt.Project}/_apis/wit/workitemsbatch?api-version=7.1";

        using var res = await _http.PostAsync(
            path,
            new StringContent(body, Encoding.UTF8, "application/json"),
            ct);

        if (!res.IsSuccessStatusCode)
        {
            var err = await res.Content.ReadAsStringAsync(ct);
            throw new HttpRequestException(
                $"workitemsbatch failed. Status={(int)res.StatusCode} {res.ReasonPhrase}\n\nBody:\n{err}\n\nPayload:\n{body}");
        }

        using var s = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct);

        var items = new List<AzdoWorkItem>();
        if (doc.RootElement.TryGetProperty("value", out var value))
        {
            foreach (var el in value.EnumerateArray())
                items.Add(AzdoWorkItem.FromJson(el));
        }

        return items;
    }

    public async Task<List<AzdoRevision>> ListRevisionsAsync(int id, CancellationToken ct)
    {
        var path = $"{_opt.Project}/_apis/wit/workItems/{id}/revisions?api-version=7.1";
        using var res = await _http.GetAsync(path, ct);
        res.EnsureSuccessStatusCode();

        using var s = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct);

        var list = new List<AzdoRevision>();
        if (doc.RootElement.TryGetProperty("value", out var value))
        {
            foreach (var el in value.EnumerateArray())
                list.Add(AzdoRevision.FromJson(el, _opt.EffortField, _opt.DueDateField));
        }
        return list;
    }

    // Work item içeriği - HTML olarak gelir.
    // Product Backlog Item için Custom.userstory, Bug için Microsoft.VSTS.TCM.ReproSteps
    public async Task<string?> GetWorkItemDescriptionHtmlAsync(int id, string? workItemType, CancellationToken ct)
    {
        // Tüm olası açıklama field'larını çek
        var fields = "Custom.userstory,Microsoft.VSTS.TCM.ReproSteps,System.Description";
        var path = $"{_opt.Project}/_apis/wit/workitems/{id}?fields={fields}&api-version=7.1";
        
        using var res = await _http.GetAsync(path, ct);
        res.EnsureSuccessStatusCode();

        using var s = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct);

        if (doc.RootElement.TryGetProperty("fields", out var fieldsObj))
        {
            // Öncelik sırası: Custom.userstory -> Microsoft.VSTS.TCM.ReproSteps -> System.Description
            var fieldNames = new[] { "Custom.userstory", "Microsoft.VSTS.TCM.ReproSteps", "System.Description" };
            
            foreach (var fieldName in fieldNames)
            {
                if (fieldsObj.TryGetProperty(fieldName, out var desc) && 
                    desc.ValueKind != JsonValueKind.Null &&
                    !string.IsNullOrWhiteSpace(desc.ValueKind == JsonValueKind.String ? desc.GetString() : desc.ToString()))
                {
                    return desc.ValueKind == JsonValueKind.String ? desc.GetString() : desc.ToString();
                }
            }
        }

        return null;
    }

    // Azure DevOps attachment'ı çek (görseller için)
    public async Task<byte[]> GetAttachmentAsync(string url, CancellationToken ct)
    {
        using var res = await _http.GetAsync(url, ct);
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadAsByteArrayAsync(ct);
    }

    // Work item'a yorum ekle (Discussion/Comments)
    // Not: Bu, UI'da snifflenen Contribution/HierarchyQuery çağrısı yerine resmi Comments API'yi kullanır.
    // PAT için vso.work_write scope gerekir.
    public async Task AddWorkItemCommentHtmlAsync(int workItemId, string htmlText, CancellationToken ct)
    {
        var text = htmlText ?? string.Empty;
        var path = $"{_opt.Project}/_apis/wit/workItems/{workItemId}/comments?format=html&api-version=7.1-preview.4";
        var body = JsonSerializer.Serialize(new { text });

        using var res = await _http.PostAsync(
            path,
            new StringContent(body, Encoding.UTF8, "application/json"),
            ct);

        if (!res.IsSuccessStatusCode)
        {
            var err = await res.Content.ReadAsStringAsync(ct);
            throw new HttpRequestException(
                $"Add comment failed. Status={(int)res.StatusCode} {res.ReasonPhrase}\n\nBody:\n{err}");
        }
    }

    private static string EscapeWiql(string s) => s.Replace("'", "''");
}

public record AzdoIdentity(string? DisplayName, string? UniqueName);

public class AzdoWorkItem
{
    public int Id { get; set; }
    public string? Url { get; set; }
    public Dictionary<string, object?> Fields { get; set; } = new();

    public static AzdoWorkItem FromJson(JsonElement el)
    {
        var wi = new AzdoWorkItem
        {
            Id = el.GetProperty("id").GetInt32(),
            Url = el.TryGetProperty("url", out var url) ? url.GetString() : null
        };

        if (el.TryGetProperty("fields", out var fields))
        {
            foreach (var p in fields.EnumerateObject())
            {
                wi.Fields[p.Name] = ReadJsonValue(p.Value);
            }
        }

        return wi;
    }

    private static object? ReadJsonValue(JsonElement v)
    {
        // JsonElement, onu üreten JsonDocument dispose olunca geçersiz olur.
        // Bu yüzden Object/Array değerlerini Clone() ile koparıyoruz.
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Number => v.TryGetInt64(out var l) ? l : v.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Object => v.Clone(),
            JsonValueKind.Array => v.Clone(),
            _ => null
        };
    }

    public string? GetString(string field) => Fields.TryGetValue(field, out var v) ? v?.ToString() : null;

    public double? GetDouble(string field)
    {
        if (!Fields.TryGetValue(field, out var v) || v is null) return null;
        if (v is long l) return l;
        if (v is double d) return d;
        if (double.TryParse(v.ToString(), out var x)) return x;
        return null;
    }

    public DateTimeOffset? GetDate(string field)
    {
        if (!Fields.TryGetValue(field, out var v) || v is null) return null;
        if (v is string s && DateTimeOffset.TryParse(s, out var dto)) return dto;
        return null;
    }

    public AzdoIdentity? GetIdentity(string field)
    {
        if (!Fields.TryGetValue(field, out var v) || v is null) return null;

        if (v is JsonElement je && je.ValueKind == JsonValueKind.Object)
        {
            string? display = je.TryGetProperty("displayName", out var dn) ? dn.GetString() : null;
            string? unique = je.TryGetProperty("uniqueName", out var un) ? un.GetString() : null;
            return new AzdoIdentity(display, unique);
        }

        return null;
    }
}

public class AzdoRevision
{
    public int Rev { get; set; }
    public DateTimeOffset ChangedDate { get; set; }

    public string? State { get; set; }
    public double? Effort { get; set; }
    public DateTimeOffset? DueDate { get; set; }

    public static AzdoRevision FromJson(JsonElement el, string effortField, string dueDateField)
    {
        var r = new AzdoRevision { Rev = el.GetProperty("rev").GetInt32() };

        if (el.TryGetProperty("fields", out var fields))
        {
            if (fields.TryGetProperty("System.ChangedDate", out var cd) && cd.ValueKind == JsonValueKind.String)
                r.ChangedDate = DateTimeOffset.Parse(cd.GetString()!);

            if (fields.TryGetProperty("System.State", out var st) && st.ValueKind == JsonValueKind.String)
                r.State = st.GetString();

            if (fields.TryGetProperty(effortField, out var ef) && ef.ValueKind == JsonValueKind.Number)
                r.Effort = ef.TryGetDouble(out var d) ? d : null;

            if (fields.TryGetProperty(dueDateField, out var dd) && dd.ValueKind == JsonValueKind.String)
            {
                if (DateTimeOffset.TryParse(dd.GetString(), out var dto))
                    r.DueDate = dto;
            }
        }
        else
        {
            r.ChangedDate = DateTimeOffset.UtcNow;
        }

        return r;
    }
}
