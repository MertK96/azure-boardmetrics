namespace AzdoBoardMetrics.Models;

public sealed record MoveAssignmentDto(
    int Priority,
    bool SetApproved = false,
    int? BeforeId = null,
    int? AfterId = null
);
