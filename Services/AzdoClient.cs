using Microsoft.Extensions.Options;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Linq;

namespace AzdoBoardMetrics.Services;

public class AzdoOptions
{
    public string OrganizationUrl { get; set; } = "";
    public string Project { get; set; } = "";
    public string? Team { get; set; } = "";
    public string Pat { get; set; } = "";
    public string[] Users { get; set; } = Array.Empty<string>();

    public string? DefaultAreaPath { get; set; }
    public string? DefaultIterationPath { get; set; }

    // Azure Boards "Board Column" filtresi. (Env: AZDO_BOARD_COLUMNS="Pre To Do,Bugs,In Progress,...")
    public string[]? BoardColumns { get; set; }


    // Board column used for "Code Review Ataması" tab (typo kept intentionally)
    public string ReadyForCodeReviewColumn { get; set; } = "Ready for Code Rewiew";

    // Work item field used to store the reviewer/owner (display name as seen in UI)
    public string ReviewOwnerFieldDisplayName { get; set; } = "Review Owner";

    // If you know the field reference name (e.g. "Custom.ReviewOwner"), set it to skip discovery
    public string? ReviewOwnerFieldReferenceName { get; set; } = null;

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

    private string? _reviewOwnerFieldRef;

    public AzdoClient(HttpClient http, IOptions<AzdoOptions> opt, IConfiguration cfg)
    {
        _http = http;
        _opt = opt.Value;

        // Allow env overrides
        _opt.OrganizationUrl = Environment.GetEnvironmentVariable("AZDO_ORG_URL") ?? _opt.OrganizationUrl;
        _opt.Project = Environment.GetEnvironmentVariable("AZDO_PROJECT") ?? _opt.Project;
        _opt.Team = Environment.GetEnvironmentVariable("AZDO_TEAM") ?? _opt.Team;
        _opt.Pat = Environment.GetEnvironmentVariable("AZDO_PAT") ?? _opt.Pat;

        // Defaults for CreateWorkItem
        _opt.DefaultAreaPath = NormalizePathEnv(Environment.GetEnvironmentVariable("AZDO_DEFAULT_AREA_PATH")) ?? _opt.DefaultAreaPath;
        _opt.DefaultIterationPath = NormalizePathEnv(Environment.GetEnvironmentVariable("AZDO_DEFAULT_ITERATION_PATH")) ?? _opt.DefaultIterationPath;

        // Board column allow-list (opsiyonel)
        var boardColsRaw = Environment.GetEnvironmentVariable("AZDO_BOARD_COLUMNS");
        if (!string.IsNullOrWhiteSpace(boardColsRaw))
        {
            _opt.BoardColumns = boardColsRaw
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .ToArray();
        }

        _http.BaseAddress = new Uri(_opt.OrganizationUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var token = Convert.ToBase64String(Encoding.ASCII.GetBytes($":{_opt.Pat}"));
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", token);
    }

    private static string? NormalizePathEnv(string? v)
    {
        if (string.IsNullOrWhiteSpace(v)) return null;
        // Render env UI may contain double backslashes (\) literally. Azure expects single '\'.
        var s = v.Trim();
        while (s.Contains("\\\\")) s = s.Replace("\\\\", "\\");
        return s;
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



    public async Task<List<int>> QueryWorkItemIdsByBoardColumnAsync(string boardColumn, CancellationToken ct)
    {
        var col = EscapeWiql(boardColumn ?? "");
        var proj = EscapeWiql(_opt.Project);

        var wiql = $@"
SELECT [System.Id]
FROM WorkItems
WHERE
    [System.TeamProject] = '{proj}'
    AND [System.BoardColumn] = '{col}'
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
            throw new Exception($"WIQL(BoardColumn) failed: {(int)res.StatusCode} {res.ReasonPhrase} :: {body}");
        }

        using var s = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct);

        var ids = new List<int>();
        if (doc.RootElement.TryGetProperty("workItems", out var wi) && wi.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in wi.EnumerateArray())
            {
                if (el.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var id))
                    ids.Add(id);
            }
        }

        return ids;
    }


    /// <summary>
    /// Runs a custom WIQL query and returns work item IDs.
    /// The query should SELECT [System.Id] FROM WorkItems ... and may include ORDER BY.
    /// </summary>
    public async Task<List<int>> QueryWorkItemIdsByWiqlAsync(string wiql, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(wiql))
            return new List<int>();

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
                $"WIQL(custom) failed. Status={(int)res.StatusCode} {res.ReasonPhrase}\n\nWIQL:\n{wiql}\n\nBody:\n{body}");
        }

        using var s = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct);

        var ids = new List<int>();
        if (doc.RootElement.TryGetProperty("workItems", out var workItems) && workItems.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in workItems.EnumerateArray())
            {
                if (el.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var id))
                    ids.Add(id);
            }
        }

        return ids;
    }


    public async Task AddCommentAsync(int workItemId, string htmlText, CancellationToken ct)
    {
        // Official Work Item Comments API
        // POST .../_apis/wit/workItems/{id}/comments?api-version=7.1-preview.4
        var path = $"{_opt.Project}/_apis/wit/workItems/{workItemId}/comments?api-version=7.1-preview.4";

        var payload = JsonSerializer.Serialize(new
        {
            text = htmlText
        });

        using var res = await _http.PostAsync(
            path,
            new StringContent(payload, Encoding.UTF8, "application/json"),
            ct);

        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            throw new Exception($"AddComment failed: {(int)res.StatusCode} {res.ReasonPhrase} :: {body}");
        }
    }

    public async Task AssignReviewOwnerAsync(int workItemId, string reviewerUniqueName, string? reviewerDisplayName, CancellationToken ct)
    {
        var fieldRef = await GetReviewOwnerFieldRefAsync(ct);
        if (string.IsNullOrWhiteSpace(fieldRef))
            throw new Exception("Review Owner field referenceName could not be resolved. Set Azdo:ReviewOwnerFieldReferenceName or Azdo:ReviewOwnerFieldDisplayName.");

        var ops = new object[]
        {
            new { op = "add", path = $"/fields/{fieldRef}", value = FormatIdentityValue(reviewerUniqueName, reviewerDisplayName) }
        };

        var path = $"{_opt.Project}/_apis/wit/workitems/{workItemId}?api-version=7.1";

        using var req = new HttpRequestMessage(new HttpMethod("PATCH"), path);
        req.Content = new StringContent(JsonSerializer.Serialize(ops), Encoding.UTF8, "application/json-patch+json");

        using var res = await _http.SendAsync(req, ct);

        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            throw new Exception($"AssignReviewOwner failed: {(int)res.StatusCode} {res.ReasonPhrase} :: {body}");
        }
    }

    private static string FormatIdentityValue(string uniqueName, string? displayName)
    {
        var u = (uniqueName ?? "").Trim();
        var d = (displayName ?? "").Trim();

        if (string.IsNullOrWhiteSpace(u)) return d;

        // If caller already sends "Name <mail>" keep it
        if (u.Contains('<') && u.Contains('>')) return u;

        // Prefer "Name <mail>" formatting (works well for identity fields)
        if (!string.IsNullOrWhiteSpace(d) && u.Contains('@'))
            return $"{d} <{u}>";

        return u;
    }

    private string GetOrganizationName()
    {
        try
        {
            var uri = new Uri(_opt.OrganizationUrl);
            var seg = uri.AbsolutePath.Trim('/');

            // dev.azure.com/{org}
            if (!string.IsNullOrWhiteSpace(seg))
                return seg;

            // visualstudio.com legacy (not expected here)
            return uri.Host.Split('.').FirstOrDefault() ?? "";
        }
        catch
        {
            return "";
        }
    }

    
public async Task UpdateWorkItemAssignedToAsync(int id, string? assigneeUniqueName, CancellationToken ct)
{
    var project = (_opt.Project ?? "").Trim();
    if (string.IsNullOrWhiteSpace(project))
        throw new Exception("Project boş. AZDO_PROJECT/appsettings üzerinden proje adı gerekli.");

    
    var areaPath = (_opt.DefaultAreaPath ?? "").Trim();
    if (string.IsNullOrWhiteSpace(areaPath))
    {
        var team = (_opt.Team ?? "").Trim();
        areaPath = string.IsNullOrWhiteSpace(team) ? project : $"{project}\\{team}";
    }

    var iterationPath = (_opt.DefaultIterationPath ?? "").Trim();
    if (string.IsNullOrWhiteSpace(iterationPath))
        iterationPath = project;
// JSON Patch: set (or clear) System.AssignedTo
    var isClear = string.IsNullOrWhiteSpace(assigneeUniqueName);
    object[] patch;
    if (isClear)
    {
        // Clear field: Azure DevOps identity fields cannot be set to null; remove the field instead.
        patch = new object[]
        {
            new { op = "remove", path = "/fields/System.AssignedTo" }
        };
    }
    else
    {
        // Compiler can't infer assigneeUniqueName is non-null in this branch.
        var v = assigneeUniqueName!.Trim();
        patch = new object[]
        {
            new { op = "add", path = "/fields/System.AssignedTo", value = v }
        };
    }

    var url = $"{project}/_apis/wit/workitems/{id}?api-version=7.1-preview.3";

    using var req = new HttpRequestMessage(new HttpMethod("PATCH"), url);
    req.Content = new StringContent(JsonSerializer.Serialize(patch), Encoding.UTF8, "application/json-patch+json");

    using var res = await _http.SendAsync(req, ct);
    if (!res.IsSuccessStatusCode)
    {
        var body = await res.Content.ReadAsStringAsync(ct);

        // Clearing AssignedTo may return 400 if the field is already missing; treat that as OK.
        if (isClear && (int)res.StatusCode == 400)
        {
            var b = (body ?? "").ToLowerInvariant();
            if (b.Contains("path") && b.Contains("does not exist"))
                return;
        }

        throw new Exception($"WI UpdateAssignedTo failed. Status={(int)res.StatusCode} {res.StatusCode} Body: {body}");
    }
}



public async Task UpdateWorkItemDescriptionAsync(int id, string descriptionHtml, CancellationToken ct)
{
    var project = (_opt.Project ?? "").Trim();
    if (string.IsNullOrWhiteSpace(project))
        throw new Exception("Project boş. AZDO_PROJECT/appsettings üzerinden proje adı gerekli.");

    // System.Description expects HTML.
    var patch = new object[]
    {
        new { op = "add", path = "/fields/System.Description", value = (descriptionHtml ?? "") }
    };

    var url = $"{project}/_apis/wit/workitems/{id}?api-version=7.1-preview.3";

    using var req = new HttpRequestMessage(new HttpMethod("PATCH"), url);
    req.Content = new StringContent(JsonSerializer.Serialize(patch), Encoding.UTF8, "application/json-patch+json");

    using var res = await _http.SendAsync(req, ct);
    if (!res.IsSuccessStatusCode)
    {
        var body = await res.Content.ReadAsStringAsync(ct);
        throw new Exception($"WI UpdateDescription failed. Status={(int)res.StatusCode} {res.StatusCode} Body: {body}");
    }
}

    // Upload attachment (used for pasting images into description)
    // Returns the attachment URL (can be embedded into System.Description as <img src="...">)
    public async Task<string> UploadAttachmentAsync(string fileName, byte[] bytes, string? contentType, CancellationToken ct)
    {
        var project = (_opt.Project ?? "").Trim();
        if (string.IsNullOrWhiteSpace(project))
            throw new Exception("Project boş. AZDO_PROJECT/appsettings üzerinden proje adı gerekli.");

        if (bytes is null || bytes.Length == 0)
            throw new Exception("Attachment bytes boş.");

        var safeName = string.IsNullOrWhiteSpace(fileName)
            ? $"pasted-{DateTime.UtcNow:yyyyMMdd-HHmmss}.png"
            : fileName.Trim();

        if (safeName.Length > 120) safeName = safeName.Substring(0, 120);

        var url = $"{project}/_apis/wit/attachments?fileName={Uri.EscapeDataString(safeName)}&api-version=7.1";

        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        var ctValue = string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType!;
        req.Content = new ByteArrayContent(bytes);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue(ctValue);

        using var res = await _http.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);

        if (!res.IsSuccessStatusCode)
            throw new Exception($"WI UploadAttachment failed. Status={(int)res.StatusCode} {res.StatusCode} Body: {body}");

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;

        if (root.TryGetProperty("url", out var urlEl) && urlEl.ValueKind == JsonValueKind.String)
        {
            var attUrl = urlEl.GetString();
            if (!string.IsNullOrWhiteSpace(attUrl)) return attUrl!;
        }

        throw new Exception("Attachment upload succeeded but response did not include url.");
    }

public async Task<AzdoWorkItem> CreateWorkItemAsync(string workItemType, string title, string descriptionHtml, int priority, CancellationToken ct)
{
    var project = (_opt.Project ?? "").Trim();
    if (string.IsNullOrWhiteSpace(project))
        throw new Exception("Project boş. AZDO_PROJECT/appsettings üzerinden proje adı gerekli.");

    var type = (workItemType ?? "").Trim();
    var t = (title ?? "").Trim();


var areaPath = (_opt.DefaultAreaPath ?? "").Trim();
if (string.IsNullOrWhiteSpace(areaPath))
{
    var team = (_opt.Team ?? "").Trim();
    areaPath = string.IsNullOrWhiteSpace(team) ? project : $"{project}\\{team}";
}

var iterationPath = (_opt.DefaultIterationPath ?? "").Trim();
if (string.IsNullOrWhiteSpace(iterationPath))
    iterationPath = project;


    // Create via JSON Patch
    // Note: Setting State directly may fail in some processes; we'll try with state and retry without.
    object[] patchWithStateAndPriority = new object[]
    {
        new { op = "add", path = "/fields/System.Title", value = t },
        new { op = "add", path = "/fields/System.Description", value = (descriptionHtml ?? "") },
        new { op = "add", path = "/fields/System.AreaPath", value = areaPath },
        new { op = "add", path = "/fields/System.IterationPath", value = iterationPath },
        new { op = "add", path = "/fields/System.State", value = "New" },
        new { op = "add", path = "/fields/Microsoft.VSTS.Common.Priority", value = Math.Clamp(priority, 1, 4) }
    };

    object[] patchWithState = new object[]
    {
        new { op = "add", path = "/fields/System.Title", value = t },
        new { op = "add", path = "/fields/System.Description", value = (descriptionHtml ?? "") },
        new { op = "add", path = "/fields/System.AreaPath", value = areaPath },
        new { op = "add", path = "/fields/System.IterationPath", value = iterationPath },
        new { op = "add", path = "/fields/System.State", value = "New" }
    };

    object[] patchMinimal = new object[]
    {
        new { op = "add", path = "/fields/System.Title", value = t },
        new { op = "add", path = "/fields/System.Description", value = (descriptionHtml ?? "") }
    };

    async Task<AzdoWorkItem> TryCreate(object[] patch, CancellationToken ct2)
    {
        var url = $"{project}/_apis/wit/workitems/${Uri.EscapeDataString(type)}?api-version=7.1-preview.3";
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Content = new StringContent(JsonSerializer.Serialize(patch), Encoding.UTF8, "application/json-patch+json");

        using var res = await _http.SendAsync(req, ct2);
        var body = await res.Content.ReadAsStringAsync(ct2);
        if (!res.IsSuccessStatusCode)
            throw new Exception($"WI Create failed. Status={(int)res.StatusCode} {res.StatusCode} Body: {body}");

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        // Return AzdoWorkItem parsed from JSON response
        return AzdoWorkItem.FromJson(root);
    }

    try
    {
        return await TryCreate(patchWithStateAndPriority, ct);
    }
    catch (Exception ex)
    {
        var msg = ex.Message.ToLowerInvariant();
        // Retry without priority/state if process rejects
        if (msg.Contains("priority") || msg.Contains("microsoft.vsts.common.priority") || msg.Contains("state"))
        {
            try { return await TryCreate(patchWithState, ct); } catch { return await TryCreate(patchMinimal, ct); }
        }
        // fallback
        return await TryCreate(patchMinimal, ct);
    }
}


public async Task UpdateWorkItemMoveAsync(int id, int priority, bool makeApproved, double? stackRank, CancellationToken ct)
{
    var project = (_opt.Project ?? "").Trim();
    if (string.IsNullOrWhiteSpace(project))
        throw new Exception("Project boş. AZDO_PROJECT/appsettings üzerinden proje adı gerekli.");

    var ops = new List<object>();

    // Priority
    ops.Add(new { op = "add", path = "/fields/Microsoft.VSTS.Common.Priority", value = Math.Clamp(priority, 1, 4) });

    // Optional ordering
    if (stackRank.HasValue)
        ops.Add(new { op = "add", path = "/fields/Microsoft.VSTS.Common.StackRank", value = stackRank.Value });

    // Optional approval (for Stories->P columns)
    if (makeApproved)
        ops.Add(new { op = "add", path = "/fields/System.State", value = "Approved" });

    var body = JsonSerializer.Serialize(ops);

    var path = $"{project}/_apis/wit/workitems/{id}?api-version=7.1";
    using var req = new HttpRequestMessage(new HttpMethod("PATCH"), path);
    req.Content = new StringContent(body, Encoding.UTF8, "application/json-patch+json");

    using var res = await _http.SendAsync(req, ct);
    var txt = await res.Content.ReadAsStringAsync(ct);
    if (!res.IsSuccessStatusCode)
        throw new Exception($"WI update failed. Status={(int)res.StatusCode} {res.ReasonPhrase}. Body: {txt}");
}


public async Task<List<AzdoUserDto>> GetAzdoUsersAsync(int top, CancellationToken ct)
    {
        var org = GetOrganizationName();
        if (string.IsNullOrWhiteSpace(org))
            throw new Exception("OrganizationUrl üzerinden org adı çözümlenemedi.");

        // Graph API host
        var baseUrl = $"https://vssps.dev.azure.com/{org}/_apis/graph/users?api-version=7.1-preview.1&$top={Math.Clamp(top, 1, 2000)}";

        var results = new List<AzdoUserDto>();
        string? continuationToken = null;

        while (results.Count < top)
        {
            var url = baseUrl;
            if (!string.IsNullOrWhiteSpace(continuationToken))
                url += $"&continuationToken={Uri.EscapeDataString(continuationToken)}";

            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            using var res = await _http.SendAsync(req, ct);

            if (!res.IsSuccessStatusCode)
            {
                var body = await res.Content.ReadAsStringAsync(ct);
                throw new Exception($"Graph users failed: {(int)res.StatusCode} {res.ReasonPhrase} :: {body}");
            }

            var json = await res.Content.ReadAsStringAsync(ct);
            var doc = JsonDocument.Parse(json);

            if (doc.RootElement.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Array)
            {
                foreach (var u in value.EnumerateArray())
                {
                    var displayName = u.TryGetProperty("displayName", out var dn) ? dn.GetString() : null;
                    var principalName = u.TryGetProperty("principalName", out var pn) ? pn.GetString() : null;
                    var mail = u.TryGetProperty("mailAddress", out var ma) ? ma.GetString() : null;

                    var unique = (principalName ?? mail ?? "").Trim();
                    var disp = (displayName ?? "").Trim();

                    if (string.IsNullOrWhiteSpace(unique) && string.IsNullOrWhiteSpace(disp))
                        continue;

                    results.Add(new AzdoUserDto
                    {
                        DisplayName = disp,
                        UniqueName = unique
                    });

                    if (results.Count >= top) break;
                }
            }

            // continuation header can be x-ms-continuationtoken
            if (res.Headers.TryGetValues("x-ms-continuationtoken", out var vals))
            {
                continuationToken = vals.FirstOrDefault();
            }
            else
            {
                continuationToken = null;
            }

            if (string.IsNullOrWhiteSpace(continuationToken))
                break;
        }

        // de-dupe by uniqueName
        var dedup = results
            .GroupBy(x => (x.UniqueName ?? x.DisplayName ?? "").Trim().ToLowerInvariant())
            .Select(g => g.First())
            .ToList();

        return dedup;
    }

public Task<string?> GetReviewOwnerFieldReferenceNameAsync(CancellationToken ct)
    => GetReviewOwnerFieldRefAsync(ct);

private async Task<string?> GetReviewOwnerFieldRefAsync(CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_opt.ReviewOwnerFieldReferenceName))
            return _opt.ReviewOwnerFieldReferenceName;

        if (!string.IsNullOrWhiteSpace(_reviewOwnerFieldRef))
            return _reviewOwnerFieldRef;

        var displayName = (_opt.ReviewOwnerFieldDisplayName ?? "").Trim();
        if (string.IsNullOrWhiteSpace(displayName))
            return null;

        var path = $"{_opt.Project}/_apis/wit/fields?api-version=7.1";
        using var res = await _http.GetAsync(path, ct);

        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            throw new Exception($"ListFields failed: {(int)res.StatusCode} {res.ReasonPhrase} :: {body}");
        }

        using var s = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct);

        if (!doc.RootElement.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Array)
            return null;

        foreach (var f in value.EnumerateArray())
        {
            var name = f.TryGetProperty("name", out var n) ? n.GetString() : null;
            var referenceName = f.TryGetProperty("referenceName", out var rn) ? rn.GetString() : null;

            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(referenceName))
                continue;

            var nm = name.Trim();
            if (string.Equals(nm, displayName, StringComparison.OrdinalIgnoreCase))
            {
                _reviewOwnerFieldRef = referenceName.Trim();
                return _reviewOwnerFieldRef;
            }
        }

        // Fuzzy fallback: contains match (helps if the process renames slightly)
        foreach (var f in value.EnumerateArray())
        {
            var name = f.TryGetProperty("name", out var n) ? n.GetString() : null;
            var referenceName = f.TryGetProperty("referenceName", out var rn) ? rn.GetString() : null;
            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(referenceName))
                continue;

            var nm = name.Trim();
            if (nm.Contains(displayName, StringComparison.OrdinalIgnoreCase))
            {
                _reviewOwnerFieldRef = referenceName.Trim();
                return _reviewOwnerFieldRef;
            }
        }

        return null;
    }
    public async Task<List<AzdoWorkItem>> GetWorkItemsBatchAsync(IEnumerable<int> ids, CancellationToken ct, IEnumerable<string>? extraFields = null)
{
    var idList = ids?.Distinct().Take(200).ToArray() ?? Array.Empty<int>();
    if (idList.Length == 0) return new List<AzdoWorkItem>();

    // Base field set
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
        "System.Tags",

        // Board fields (may not exist in every org/process). We'll retry without them if server rejects.
        "System.BoardColumn",
        "System.BoardLane"
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

    if (extraFields is not null)
    {
        foreach (var ef in extraFields)
        {
            if (!string.IsNullOrWhiteSpace(ef) && !fields.Contains(ef))
                fields.Add(ef);
        }
    }

    // Try once with board fields; if server returns 400 due to unknown field, retry without them.
    try
    {
        return await GetWorkItemsBatchInternalAsync(idList, fields, ct);
    }
    catch (HttpRequestException ex) when (ex.Data.Contains("StatusCode") && (int)ex.Data["StatusCode"]! == 400)
    {
        fields.Remove("System.BoardColumn");
        fields.Remove("System.BoardLane");
        return await GetWorkItemsBatchInternalAsync(idList, fields, ct);
    }
}

private async Task<List<AzdoWorkItem>> GetWorkItemsBatchInternalAsync(int[] idList, List<string> fields, CancellationToken ct)
{
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

        var hre = new HttpRequestException($"workitemsbatch failed: {(int)res.StatusCode} {res.ReasonPhrase} :: {err}");
        hre.Data["StatusCode"] = (int)res.StatusCode;
        throw hre;
    }

    using var s = await res.Content.ReadAsStreamAsync(ct);
    using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct);

    var items = new List<AzdoWorkItem>();
    if (doc.RootElement.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Array)
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



    // Binary içerik (img, attachment) - content-type ile birlikte
    public async Task<(byte[] Bytes, string ContentType)> GetBinaryAsync(string url, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Accept.Clear();
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("*/*"));

        using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        res.EnsureSuccessStatusCode();

        var ctHeader = res.Content.Headers.ContentType?.ToString();
        if (string.IsNullOrWhiteSpace(ctHeader)) ctHeader = "application/octet-stream";

        var bytes = await res.Content.ReadAsByteArrayAsync(ct);
        return (bytes, ctHeader);
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

        // Some identity fields (especially custom ones) may come back as a string like
        // "Name Surname <mail@company.com>" or just "mail@company.com".
        if (v is string s)
        {
            var parsed = ParseIdentityString(s);
            if (parsed is not null) return parsed;

            // As a fallback keep the raw string as display name.
            if (!string.IsNullOrWhiteSpace(s))
                return new AzdoIdentity(s.Trim(), null);

            return null;
        }

        if (v is JsonElement je && je.ValueKind == JsonValueKind.Object)
        {
            string? display = je.TryGetProperty("displayName", out var dn) ? dn.GetString() : null;
            string? unique = je.TryGetProperty("uniqueName", out var un) ? un.GetString() : null;
            return new AzdoIdentity(display, unique);
        }

        return null;
    }

    private static AzdoIdentity? ParseIdentityString(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var t = s.Trim();

        // "Name <mail>"
        var lt = t.LastIndexOf('<');
        var gt = t.LastIndexOf('>');
        if (lt >= 0 && gt > lt)
        {
            var name = t.Substring(0, lt).Trim();
            var mail = t.Substring(lt + 1, gt - lt - 1).Trim();
            if (!string.IsNullOrWhiteSpace(mail))
                return new AzdoIdentity(string.IsNullOrWhiteSpace(name) ? mail : name, mail);
        }

        // plain email
        if (t.Contains('@') && !t.Contains(' '))
            return new AzdoIdentity(t, t);

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