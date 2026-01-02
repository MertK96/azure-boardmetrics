namespace AzdoBoardMetrics.Models;

/// <summary>
/// Work item date update payload.
/// Accepts ISO-8601, yyyy-MM-dd, or datetime-local values.
/// </summary>
public sealed record UpdateDatesRequest(string? StartDate, string? DueDate);
