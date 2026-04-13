import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
} from 'chart.js'
import { Doughnut, Bar } from 'react-chartjs-2'

ChartJS.register(
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement
)

function Analytics({ goals, completedGoals }) {
  const activeAcceptedTasks = goals.flatMap(goal =>
    goal.microGoals.filter(mg => !mg.suggested)
  )

  const completedTasks = activeAcceptedTasks.filter(task => task.completed).length
  const uncompletedTasks = activeAcceptedTasks.filter(task => !task.completed).length
  const totalTasks = completedTasks + uncompletedTasks

  const averageProgress =
    totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100)

  const productiveGoal =
    goals.length === 0
      ? '—'
      : goals.reduce((best, current) => {
          const bestCompleted = best.microGoals.filter(
            mg => !mg.suggested && mg.completed
          ).length

          const currentCompleted = current.microGoals.filter(
            mg => !mg.suggested && mg.completed
          ).length

          return currentCompleted > bestCompleted ? current : best
        }, goals[0]).text

  const doughnutData = {
    labels: ['Выполнено', 'Невыполнено'],
    datasets: [
      {
        data: [completedTasks, uncompletedTasks],
        backgroundColor: ['#c9bea4', '#efefef'],
        borderWidth: 0,
        hoverOffset: 4,
      },
    ],
  }

  const goalsProgressData = {
    labels: goals.map(goal => goal.text),
    datasets: [
      {
        label: 'Прогресс',
        data: goals.map(goal => {
          const accepted = goal.microGoals.filter(mg => !mg.suggested)
          const done = accepted.filter(mg => mg.completed).length
          return accepted.length === 0
            ? 0
            : Math.round((done / accepted.length) * 100)
        }),
        backgroundColor: '#c9bea4',
        borderRadius: 8,
      },
    ],
  }

  return (
    <div style={{ marginTop: '20px' }}>
      <h2 style={{ marginBottom: '20px' }}>📊 Аналитика</h2>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '20px',
          marginBottom: '24px',
        }}
      >
        <div
          style={{
            background: '#f7f7f7',
            padding: '24px',
            borderRadius: '16px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: '18px', color: '#23384d' }}>
            Аналитика системы
          </h3>

          <div style={{ display: 'grid', gap: '12px' }}>
            <div style={rowStyle}>
              <span>Всего задач</span>
              <strong>{totalTasks}</strong>
            </div>

            <div style={rowStyle}>
              <span>Выполнено</span>
              <strong>{completedTasks}</strong>
            </div>

            <div style={rowStyle}>
              <span>Невыполнено</span>
              <strong>{uncompletedTasks}</strong>
            </div>

            <div style={rowStyle}>
              <span>Средний прогресс</span>
              <strong>{averageProgress}%</strong>
            </div>

            <div style={rowStyle}>
              <span>Завершённые цели</span>
              <strong>{completedGoals.length}</strong>
            </div>

            <div style={rowStyle}>
              <span>Самая продуктивная цель</span>
              <strong style={{ textAlign: 'right', maxWidth: '180px' }}>
                {productiveGoal}
              </strong>
            </div>
          </div>
        </div>

        <div
          style={{
            background: '#f7f7f7',
            padding: '24px',
            borderRadius: '16px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '320px',
          }}
        >
          <h3
            style={{
              marginTop: 0,
              marginBottom: '18px',
              color: '#23384d',
              alignSelf: 'flex-start',
            }}
          >
            Общий прогресс
          </h3>

          <div
            style={{
              position: 'relative',
              width: '240px',
              height: '240px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Doughnut
              data={doughnutData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                cutout: '72%',
                plugins: {
                  legend: {
                    position: 'top',
                    labels: {
                      boxWidth: 12,
                      font: {
                        size: 13,
                      },
                    },
                  },
                },
              }}
            />

            <div
              style={{
                position: 'absolute',
                fontSize: '36px',
                fontWeight: '700',
                color: '#7d7461',
              }}
            >
              {averageProgress}%
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          background: '#f7f7f7',
          padding: '24px',
          borderRadius: '16px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: '18px', color: '#23384d' }}>
          Прогресс по целям
        </h3>

        {goals.length === 0 ? (
          <p style={{ color: '#666' }}>
            Пока нет активных целей для отображения графика.
          </p>
        ) : (
          <div style={{ height: '340px' }}>
            <Bar
              data={goalsProgressData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: {
                    display: false,
                  },
                },
                scales: {
                  y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                      stepSize: 20,
                    },
                    grid: {
                      color: '#e5e5e5',
                    },
                  },
                  x: {
                    grid: {
                      display: false,
                    },
                  },
                },
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

const rowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: '#ffffff',
  padding: '12px 14px',
  borderRadius: '10px',
  color: '#23384d',
}

export default Analytics