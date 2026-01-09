using AzdoBoardMetrics.Models;
using AzdoBoardMetrics.Services;

namespace AzdoBoardMetrics.Endpoints;

public static class AssignmentMoveEndpoints
{
    public static void MapAssignmentMoveEndpoints(this WebApplication app)
    {
        // Move card between priority columns (and optionally approve when coming from Stories/New lane).
        // Also supports ordering inside a column via StackRank (BeforeId/AfterId).
        app.MapPatch("/api/assignments/{id:int}/move",
            async (AzdoClient az, int id, MoveAssignmentDto dto, CancellationToken ct) =>
            {
                try
                {
                    var p = dto.Priority;
                    if (p < 1 || p > 4)
                        return Results.BadRequest(new { message = "Priority 1-4 olmalı." });

                    var fields = new Dictionary<string, object?>
                    {
                        ["Microsoft.VSTS.Common.Priority"] = p
                    };


                    // Approve rules:
                    // - Explicit: client sets MakeApproved=true
                    // - Implicit: when moving an item currently in "New" state from Stories lane.
                    //   In practice, this is a "User Story" / "Product Backlog Item" that should become Approved
                    //   as soon as it is prioritized.
                    var shouldApprove = dto.MakeApproved;
                    if (!shouldApprove)
                    {
                        var wi = (await az.GetWorkItemsBatchAsync(new[] { id }, ct,
                            extraFields: new[] { "System.State", "System.WorkItemType" }))
                            .FirstOrDefault();

                        var state = wi?.Fields.TryGetValue("System.State", out var s) == true ? s?.ToString() : null;
                        var type = wi?.Fields.TryGetValue("System.WorkItemType", out var t) == true ? t?.ToString() : null;

                        var isStoryType = !string.IsNullOrWhiteSpace(type) &&
                                          (type.Contains("story", StringComparison.OrdinalIgnoreCase) ||
                                           type.Contains("backlog", StringComparison.OrdinalIgnoreCase));

                        if (isStoryType && string.Equals(state, "New", StringComparison.OrdinalIgnoreCase))
                            shouldApprove = true;
                    }

                    if (shouldApprove)
                        fields["System.State"] = "Approved";

                    // Optional ordering: compute a new StackRank between neighbours.
                    // If both neighbours are missing, we don't touch StackRank.
                    var newRank = await TryComputeStackRankAsync(az, dto.BeforeId, dto.AfterId, ct);
                    if (newRank is not null)
                        fields["Microsoft.VSTS.Common.StackRank"] = newRank.Value;

                    await az.UpdateWorkItemFieldsAsync(id, fields, ct);
                    return Results.Ok(new { ok = true });
                }
                catch (Exception ex)
                {
                    var msg = ex.Message;
                    if (msg.Length > 2000) msg = msg[..2000];

                    // Map ADO revision mismatch to 409 so the UI can treat it as a retryable conflict
                    // instead of a generic "bad gateway".
                    if (msg.Contains("WorkItemRevisionMismatchException", StringComparison.OrdinalIgnoreCase))
                        return Results.Json(new { message = msg }, statusCode: 409);

                    return Results.Json(new { message = msg }, statusCode: 502);
                }
            });
    }

    private static async Task<double?> TryComputeStackRankAsync(AzdoClient az, int? beforeId, int? afterId, CancellationToken ct)
    {
        if (beforeId is null && afterId is null) return null;

        double? before = null;
        double? after = null;

        var ids = new List<int>();
        if (beforeId is not null) ids.Add(beforeId.Value);
        if (afterId is not null && afterId != beforeId) ids.Add(afterId.Value);

        var items = await az.GetWorkItemsBatchAsync(ids.ToArray(), ct, extraFields: new[] { "Microsoft.VSTS.Common.StackRank" });
        var byId = items.ToDictionary(x => x.Id, x => x);

        if (beforeId is not null && byId.TryGetValue(beforeId.Value, out var bwi))
            before = bwi.GetDouble("Microsoft.VSTS.Common.StackRank");

        if (afterId is not null && byId.TryGetValue(afterId.Value, out var awi))
            after = awi.GetDouble("Microsoft.VSTS.Common.StackRank");

        // If both exist -> middle
        if (before is not null && after is not null)
            return (before.Value + after.Value) / 2.0;

        // Only after -> place before it
        if (before is null && after is not null)
            return after.Value - 1000.0;

        // Only before -> place after it
        if (before is not null && after is null)
            return before.Value + 1000.0;

        return null;
    }
}
