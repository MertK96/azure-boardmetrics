using Microsoft.EntityFrameworkCore;
using System.ComponentModel.DataAnnotations;

namespace AzdoBoardMetrics.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<WorkItemEntity> WorkItems => Set<WorkItemEntity>();
    public DbSet<WorkItemRevisionEntity> WorkItemRevisions => Set<WorkItemRevisionEntity>();
    public DbSet<FeedbackEntity> Feedback => Set<FeedbackEntity>();
    public DbSet<ReviewAssignmentEntity> ReviewAssignments => Set<ReviewAssignmentEntity>();
    public DbSet<KvEntity> Kv => Set<KvEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<WorkItemEntity>().HasKey(x => x.Id);
        modelBuilder.Entity<WorkItemRevisionEntity>().HasKey(x => x.Id);
        modelBuilder.Entity<WorkItemRevisionEntity>()
            .HasIndex(x => new { x.WorkItemId, x.Rev })
            .IsUnique();

        modelBuilder.Entity<FeedbackEntity>().HasKey(x => x.Id);
        modelBuilder.Entity<ReviewAssignmentEntity>().HasKey(x => x.Id);
        modelBuilder.Entity<KvEntity>().HasKey(x => x.Key);
    }
}

public class WorkItemEntity
{
    [Key]
    public int Id { get; set; }

    public string? Url { get; set; }

    public string? Title { get; set; }
    public string? WorkItemType { get; set; }

    public string? State { get; set; }
    public string? BoardColumn { get; set; }
    public string? BoardLane { get; set; }

    public string? AssignedToDisplayName { get; set; }
    public string? AssignedToUniqueName { get; set; }

    public string? IterationPath { get; set; }
    public string? Tags { get; set; }

    public double? Effort { get; set; }
    public DateTimeOffset? DueDate { get; set; }

    public DateTimeOffset CreatedDate { get; set; }
    public DateTimeOffset ChangedDate { get; set; }

    // Derived timeline
    public DateTimeOffset? StartDate { get; set; }
    public DateTimeOffset? InProgressDate { get; set; }
    public DateTimeOffset? DoneDate { get; set; }
    public DateTimeOffset? DueDateSetDate { get; set; }

    // "Effective" due date used for board metrics.
    // If DueDate is null, this may fall back to ForecastDueDate (computed from Effort).
    public DateTimeOffset? EffectiveDueDate { get; set; }

    // "due" | "forecast" | null
    public string? EffectiveDueDateSource { get; set; }

    // Derived metrics (date-based days)
    public int? ExpectedDays { get; set; }
    public DateTimeOffset? ForecastDueDate { get; set; }
    public int? CommitmentVarianceDays { get; set; }  // Done - Due
    public int? ForecastVarianceDays { get; set; }    // Done - ForecastDue
    public int? SlackDays { get; set; }               // Due - ForecastDue
    public int? PlanningLagDays { get; set; }         // DueSet - Start

    public int DueDateChangedCount { get; set; }
    public int TotalDueDateSlipDays { get; set; }

    // Pool flags
    public bool NeedsFeedback { get; set; }
    public string? PoolReason { get; set; }
    public DateTimeOffset? LastFeedbackAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class WorkItemRevisionEntity
{
    [Key]
    public long Id { get; set; } // DB id
    public int WorkItemId { get; set; }
    public int Rev { get; set; }
    public DateTimeOffset ChangedDate { get; set; }

    public string? State { get; set; }
    public DateTimeOffset? DueDate { get; set; }
    public double? Effort { get; set; }
}

public class FeedbackEntity
{
    [Key]
    public long Id { get; set; }
    public int WorkItemId { get; set; }

    // "general" | "feedback"
    [MaxLength(64)]
    public string? Category { get; set; }

    [MaxLength(64)]
    public string? Impact { get; set; }

    [MaxLength(4000)]
    public string Note { get; set; } = "";

    [MaxLength(128)]
    public string CreatedBy { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    // Notlar sekmesinde checkbox ile çözüldü işaretlemek için
    public bool IsResolved { get; set; }
    public DateTimeOffset? ResolvedAt { get; set; }
}

public class ReviewAssignmentEntity
{
    [Key]
    public long Id { get; set; }
    public int WorkItemId { get; set; }

    [MaxLength(256)]
    public string Reviewer { get; set; } = "";

    [MaxLength(128)]
    public string AssignedBy { get; set; } = "";

    [MaxLength(1000)]
    public string Note { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class KvEntity
{
    [Key]
    [MaxLength(128)]
    public string Key { get; set; } = "";

    [MaxLength(4000)]
    public string Value { get; set; } = "";
}
