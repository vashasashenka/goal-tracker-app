function MicroGoal({
  text,
  completed,
  onToggle,
  onAccept,
  onReject,
  suggested,
}) {
  if (suggested) {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 70px 70px',
          gap: '10px',
          alignItems: 'center',
          padding: '14px',
          borderRadius: '16px',
          background: '#f5ecd8',
        }}
      >
        <div
          style={{
            fontSize: '16px',
            lineHeight: 1.45,
            color: '#5d5d5d',
          }}
        >
          {text}
        </div>

        <button
          onClick={onAccept}
          style={{
            width: '70px',
            height: '56px',
            borderRadius: '14px',
            border: 'none',
            background: '#f3f3f3',
            fontSize: '28px',
            fontWeight: '700',
            cursor: 'pointer',
            color: '#4a4a4a',
          }}
        >
          +
        </button>

        <button
          onClick={onReject}
          style={{
            width: '70px',
            height: '56px',
            borderRadius: '14px',
            border: 'none',
            background: '#f3f3f3',
            fontSize: '26px',
            fontWeight: '700',
            cursor: 'pointer',
            color: '#4a4a4a',
          }}
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '10px 4px',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={completed}
        onChange={onToggle}
        style={{
          width: '22px',
          height: '22px',
          cursor: 'pointer',
        }}
      />

      <span
        style={{
          fontSize: '18px',
          lineHeight: 1.4,
          color: '#232323',
          textDecoration: completed ? 'line-through' : 'none',
          opacity: completed ? 0.6 : 1,
        }}
      >
        {text}
      </span>
    </label>
  )
}

export default MicroGoal