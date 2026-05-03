import { useMemo } from 'react'
import { CalendarBlank, Check } from '@phosphor-icons/react'
import { normalizeGoalForStats } from '../utils/statistics'

function formatCompletedDate(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 'Без даты'
  return date
    .toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
    })
    .replace(/\s?г\.$/, '')
    .replace(/\./g, '')
}

function formatStepsWord(count) {
  return Math.trunc(Number(count) || 0) === 1 ? 'шага' : 'шагов'
}

function formatStepSummary(goal) {
  const total = goal.steps.length
  const completed = goal.steps.filter(step => step.completed).length
  if (total <= 0) return 'Цель завершена'
  return `Выполнено ${completed} из ${total} ${formatStepsWord(total)}`
}

function sortCompletedGoals(goals) {
  return [...goals].sort((left, right) => {
    const a = new Date(left.completedAt || left.createdAt || 0).getTime()
    const b = new Date(right.completedAt || right.createdAt || 0).getTime()
    return b - a
  })
}

function CompletedGoalsPreview({
  goals,
  title = 'Завершённые цели',
  subtitle = 'История ваших достижений',
  limit = 3,
  onOpenAll,
  openLabel = 'Показать все цели',
  className = '',
}) {
  const normalizedGoals = useMemo(
    () =>
      sortCompletedGoals(
        (Array.isArray(goals) ? goals : []).map(goal =>
          normalizeGoalForStats(goal, { completed: true })
        )
      ),
    [goals]
  )

  const visibleGoals = normalizedGoals.slice(0, limit)
  const canOpenAll = typeof onOpenAll === 'function' && normalizedGoals.length > 0

  return (
    <article className={`card completed-preview-card ${className}`.trim()}>
      <div className="completed-preview-head">
        <h2 className="stats-card-title">{title}</h2>
        <p className="secondary-text completed-preview-subtitle">{subtitle}</p>
      </div>

      {visibleGoals.length === 0 ? (
        <div className="completed-preview-empty">
          <strong>Пока нет завершённых целей</strong>
          <p className="secondary-text">Когда вы завершите первую цель, она появится здесь.</p>
        </div>
      ) : (
        <>
          <div className="completed-preview-list">
            {visibleGoals.map(goal => (
              <div key={goal.id} className="completed-preview-row">
                <span className="completed-preview-check" aria-hidden="true">
                  <Check size={14} weight="bold" />
                </span>

                <div className="completed-preview-main">
                  <strong>{goal.title}</strong>
                  <span className="completed-preview-meta">{formatStepSummary(goal)}</span>
                </div>

                <span className="completed-preview-date">
                  <CalendarBlank size={14} weight="regular" aria-hidden="true" />
                  <span>{formatCompletedDate(goal.completedAt)}</span>
                </span>
              </div>
            ))}
          </div>

          {canOpenAll ? (
            <button type="button" className="text-button completed-preview-open" onClick={onOpenAll}>
              {openLabel}
            </button>
          ) : null}
        </>
      )}
    </article>
  )
}

export default CompletedGoalsPreview
