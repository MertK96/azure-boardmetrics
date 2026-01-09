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
                catch (AzdoApiException aex) when (aex.StatusCode == 409)
                {
                    // This often happens when the same item is patched twice in quick succession
                    // (e.g., duplicate drag/drop handlers or back-to-back moves).
                    // If the desired end state is already applied, treat as success.

                    var desiredPriority = dto.Priority;

                    // Re-evaluate approval rule to know what we expected.
                    var desiredApproved = dto.MakeApproved;
                    if (!desiredApproved)
                    {
                        var wi0 = (await az.GetWorkItemsBatchAsync(new[] { id }, ct,
                            extraFields: new[] { "System.State", "System.WorkItemType" }))
                            .FirstOrDefault();

                        var state0 = wi0?.Fields.TryGetValue("System.State", out var s0) == true ? s0?.ToString() : null;
                        var type0 = wi0?.Fields.TryGetValue("System.WorkItemType", out var t0) == true ? t0?.ToString() : null;

                        var isStoryType0 = !string.IsNullOrWhiteSpace(type0) &&
                                           (type0.Contains("story", StringComparison.OrdinalIgnoreCase) ||
                                            type0.Contains("backlog", StringComparison.OrdinalIgnoreCase));

                        if (isStoryType0 && string.Equals(state0, "New", StringComparison.OrdinalIgnoreCase))
                            desiredApproved = true;
                    }

                    var wi = (await az.GetWorkItemsBatchAsync(new[] { id }, ct,
                        extraFields: new[] { "Microsoft.VSTS.Common.Priority", "System.State" }))
                        .FirstOrDefault();

                    int? currentPriority = null;
                    if (wi?.Fields != null && wi.Fields.TryGetValue("Microsoft.VSTS.Common.Priority", out var cp) && cp != null)
                    {
                        // Azure DevOps can return numbers as int/long/double or as string depending on field.
                        if (cp is int i) currentPriority = i;
                        else if (cp is long l) currentPriority = (int)l;
                        else if (cp is double d) currentPriority = (int)d;
                        else if (int.TryParse(cp.ToString(), out var parsed)) currentPriority = parsed;
                    }
                    var currentState = wi?.Fields.TryGetValue("System.State", out var cs) == true ? cs?.ToString() : null;

                    var priorityOk = currentPriority == desiredPriority;
                    var stateOk = !desiredApproved || string.Equals(currentState, "Approved", StringComparison.OrdinalIgnoreCase);

                    if (priorityOk && stateOk)
                        return Results.Ok(new { ok = true, conflictResolved = true });

                    var msg = aex.ResponseBody ?? aex.Message;
                    if (msg.Length > 2000) msg = msg[..2000];
                    return Results.Json(new { message = msg }, statusCode: 409);
                }
                catch (Exception ex)
                {
                    // Always prefer clean JSON errors (avoid ProblemDetails 502 noise in the UI)
                    var msg = ex.Message;
                    if (msg.Length > 2000) msg = msg[..2000];
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
