namespace AzdoBoardMetrics.Dtos;

public record MoveAssignmentDto(int Priority, bool SetApproved, int? BeforeId, int? AfterId);
