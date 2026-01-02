namespace AzdoBoardMetrics.Models;

/// <summary>
/// Work item date update payload.
/// Accepts ISO-8601, yyyy-MM-dd, or datetime-local values.
///
/// Notes:
/// - "StarterDate" is the preferred JSON property (maps to Azure field "Starter Date").
/// - "StartDate" is kept for backward compatibility with older UI versions.
/// </summary>
public sealed record UpdateDatesRequest(string? StarterDate, string? StartDate, string? DueDate);
