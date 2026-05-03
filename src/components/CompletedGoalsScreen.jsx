import { useMemo } from 'react'
import { ArrowLeft, CalendarBlank, Check } from '@phosphor-icons/react'
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

function CompletedGoalsScreen({ goals, onBack, onClearHistory }) {
  const normalizedGoals = useMemo(
    () =>
      sortCompletedGoals(
        (Array.isArray(goals) ? goals : []).map(goal =>
          normalizeGoalForStats(goal, { completed: true })
        )
      ),
    [goals]
  )

  return (
    <section className="screen screen--journal completed-goals-screen">
      <header className="screen-header completed-goals-screen-header">
        <button type="button" className="text-button text-button--with-icon completed-goals-back" onClick={onBack}>
          <ArrowLeft size={18} weight="regular" aria-hidden />
          Назад
        </button>

        <div className="screen-header-copy">
          <h1>Завершённые цели</h1>
          <p className="secondary-text completed-goals-screen-copy">История ваших достижений</p>
        </div>
      </header>

      {normalizedGoals.length === 0 ? (
        <div className="card completed-goals-screen-empty">
          <strong>Пока нет завершённых целей</strong>
          <p className="secondary-text">Когда вы завершите первую цель, она появится в этом разделе.</p>
        </div>
      ) : (
        <div className="completed-goals-screen-list">
          {normalizedGoals.map(goal => (
            <article key={goal.id} className="completed-goals-screen-row">
              <span className="completed-goals-screen-check" aria-hidden="true">
                <Check size={15} weight="bold" />
              </span>

              <div className="completed-goals-screen-main">
                <strong>{goal.title}</strong>
                <span className="completed-goals-screen-meta">{formatStepSummary(goal)}</span>
              </div>

              <span className="completed-goals-screen-date">
                <CalendarBlank size={14} weight="regular" aria-hidden="true" />
                <span>{formatCompletedDate(goal.completedAt)}</span>
              </span>
            </article>
          ))}
        </div>
      )}

      <div className="completed-goals-screen-actions">
        <button type="button" className="primary-button completed-goals-screen-action" onClick={onBack}>
          Назад к статистике
        </button>
        {typeof onClearHistory === 'function' && normalizedGoals.length > 0 ? (
          <button
            type="button"
            className="text-button completed-goals-screen-clear"
            onClick={onClearHistory}
          >
            Очистить историю
          </button>
        ) : null}
      </div>
    </section>
  )
}

export default CompletedGoalsScreen
