namespace AzdoBoardMetrics.Models;

public sealed record MoveAssignmentDto(
    int Priority,
    bool MakeApproved = false,
    int? BeforeId = null,
    int? AfterId = null
);
