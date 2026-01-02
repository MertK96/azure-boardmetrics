using AzdoBoardMetrics.Data;

namespace AzdoBoardMetrics.Services;

public class MetricsService
{
    public WorkItemEntity ApplyMetrics(WorkItemEntity wi, AzdoOptions opt, List<WorkItemRevisionEntity> revs)
    {
        // Derive StartDate / DoneDate / DueDateSetDate from revisions (ordered)
        var ordered = revs.OrderBy(r => r.Rev).ToList();

        wi.StartDate = FindFirstStateEnter(ordered, opt.StartStates) ?? wi.StartDate;
        wi.InProgressDate = FindFirstStateEnter(ordered, opt.InProgressStates) ?? wi.InProgressDate;
        wi.DoneDate = FindFirstStateEnter(ordered, opt.DoneStates) ?? wi.DoneDate;

        // DueDateSetDate: first revision where DueDate became non-null
        wi.DueDateSetDate = FindDueDateSetDate(ordered);

        // DueDate changes and slip days (date-based)
        var dueChanges = CountDueDateChangesAndSlip(ordered);
        wi.DueDateChangedCount = dueChanges.changedCount;
        wi.TotalDueDateSlipDays = dueChanges.totalSlipDays;

        // Expected days from Effort
        wi.ExpectedDays = wi.Effort is null ? null : ComputeExpectedDays(wi.Effort.Value, opt.WorkdayEffortPerDay, opt.ExpectedDaysRounding);

        // Forecast due date
        // If StartDate is missing (often on Bugs), fall back to InProgressDate.
        var forecastBase = wi.StartDate ?? wi.InProgressDate;
        if (forecastBase is not null && wi.ExpectedDays is not null)
        {
            var start = forecastBase.Value.Date;
            var forecast = opt.UseBusinessDays ? AddBusinessDays(start, wi.ExpectedDays.Value) : start.AddDays(wi.ExpectedDays.Value);
            wi.ForecastDueDate = new DateTimeOffset(forecast, TimeSpan.Zero);
        }
        else
        {
            wi.ForecastDueDate = null;
        }

        // EffectiveDueDate: if DueDate exists use it; otherwise fall back to ForecastDueDate.
        if (wi.DueDate is not null)
        {
            wi.EffectiveDueDate = wi.DueDate;
            wi.EffectiveDueDateSource = "due";
        }
        else if (wi.ForecastDueDate is not null)
        {
            wi.EffectiveDueDate = wi.ForecastDueDate;
            wi.EffectiveDueDateSource = "forecast";
        }
        else
        {
            wi.EffectiveDueDate = null;
            wi.EffectiveDueDateSource = null;
        }

        // Variances (only when DoneDate exists)
        if (wi.DoneDate is not null)
        {
            var done = wi.DoneDate.Value.Date;

            if (wi.EffectiveDueDate is not null)
                wi.CommitmentVarianceDays = DaysBetween(wi.EffectiveDueDate.Value.Date, done);

            if (wi.ForecastDueDate is not null)
                wi.ForecastVarianceDays = DaysBetween(wi.ForecastDueDate.Value.Date, done);

            if (wi.EffectiveDueDate is not null && wi.ForecastDueDate is not null)
                wi.SlackDays = DaysBetween(wi.ForecastDueDate.Value.Date, wi.EffectiveDueDate.Value.Date);
        }
        else
        {
            wi.CommitmentVarianceDays = null;
            wi.ForecastVarianceDays = null;
            wi.SlackDays = null;
        }

        if (wi.DueDateSetDate is not null && wi.StartDate is not null)
            wi.PlanningLagDays = DaysBetween(wi.StartDate.Value.Date, wi.DueDateSetDate.Value.Date);

        return wi;
    }

    public void ApplyPoolRules(WorkItemEntity wi, AzdoOptions opt)
    {
        wi.NeedsFeedback = false;
        wi.PoolReason = null;

        // Only evaluate if it has due/forecast or obvious late signals
        if (wi.DoneDate is not null)
        {
            // Commitment late
            if (wi.CommitmentVarianceDays is not null && wi.CommitmentVarianceDays.Value >= opt.PoolRules.CommitmentLateDaysThreshold)
            {
                wi.NeedsFeedback = true;
                wi.PoolReason = $"Commitment late (+{wi.CommitmentVarianceDays}d)";
                return;
            }

            // Forecast late
            if (wi.ForecastVarianceDays is not null && wi.ForecastVarianceDays.Value >= opt.PoolRules.ForecastLateDaysThreshold)
            {
                wi.NeedsFeedback = true;
                wi.PoolReason = $"Forecast late (+{wi.ForecastVarianceDays}d)";
                return;
            }
        }

        // Planning lag (due date set too late after start)
        if (wi.PlanningLagDays is not null && wi.PlanningLagDays.Value > opt.PoolRules.MaxPlanningLagDays)
        {
            wi.NeedsFeedback = true;
            wi.PoolReason = $"Due date set late (+{wi.PlanningLagDays}d after start)";
            return;
        }

        // Due date slip
        if (wi.DueDateChangedCount >= 1 && wi.TotalDueDateSlipDays >= 1)
        {
            wi.NeedsFeedback = true;
            wi.PoolReason = $"Due date slipped (+{wi.TotalDueDateSlipDays}d over {wi.DueDateChangedCount} changes)";
            return;
        }
    }

    private static DateTimeOffset? FindFirstStateEnter(List<WorkItemRevisionEntity> ordered, string[] targetStates)
    {
        var set = new HashSet<string>(targetStates, StringComparer.OrdinalIgnoreCase);

        string? prev = null;
        foreach (var r in ordered)
        {
            if (r.State is null) continue;

            if (prev is null)
            {
                if (set.Contains(r.State))
                    return r.ChangedDate;
            }
            else
            {
                if (!set.Contains(prev) && set.Contains(r.State))
                    return r.ChangedDate;
            }

            prev = r.State;
        }
        return null;
    }

    private static DateTimeOffset? FindDueDateSetDate(List<WorkItemRevisionEntity> ordered)
    {
        DateTimeOffset? prev = null;
        foreach (var r in ordered)
        {
            if (prev is null && r.DueDate is not null)
                return r.ChangedDate;

            prev = r.DueDate;
        }
        return null;
    }

    private static (int changedCount, int totalSlipDays) CountDueDateChangesAndSlip(List<WorkItemRevisionEntity> ordered)
    {
        DateTimeOffset? prev = null;
        int changed = 0;
        int slip = 0;

        foreach (var r in ordered)
        {
            var cur = r.DueDate;
            if (cur is null)
            {
                prev = cur;
                continue;
            }

            if (prev is null)
            {
                prev = cur;
                continue;
            }

            if (cur.Value.Date != prev.Value.Date)
            {
                changed++;
                // slip positive only when moved later
                var delta = DaysBetween(prev.Value.Date, cur.Value.Date);
                if (delta > 0) slip += delta;
            }

            prev = cur;
        }

        return (changed, slip);
    }

    private static int ComputeExpectedDays(double effort, double effortPerDay, string rounding)
    {
        if (effortPerDay <= 0) effortPerDay = 4.0;
        var raw = effort / effortPerDay;

        return rounding.ToLowerInvariant() switch
        {
            "floor" => (int)Math.Floor(raw),
            "round" => (int)Math.Round(raw, MidpointRounding.AwayFromZero),
            _ => (int)Math.Ceiling(raw)
        };
    }

    private static DateTime AddBusinessDays(DateTime startDate, int days)
    {
        if (days <= 0) return startDate;
        var d = startDate;
        int added = 0;
        while (added < days)
        {
            d = d.AddDays(1);
            if (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) continue;
            added++;
        }
        return d;
    }

    private static int DaysBetween(DateTime start, DateTime end)
        => (int)(end.Date - start.Date).TotalDays;
}
