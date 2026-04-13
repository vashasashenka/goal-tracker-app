import ProgressCircle from "./ProgressCircle";

function Goal({ text, completed, onToggle, onDelete, progress }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        background: completed ? "#d4ffd4" : "#f0f0f0",
        padding: "10px",
        margin: "10px",
        borderRadius: "5px",
        justifyContent: "space-between"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", flex: 1 }}>
        <input
          type="checkbox"
          checked={completed}
          onChange={onToggle}
          style={{ marginRight: "10px" }}
        />

        <span>{text}</span>
      </div>

      {/* Круг прогресса */}
      <div style={{ marginRight: "15px" }}>
        <ProgressCircle progress={progress} />
      </div>

      <button
        onClick={onDelete}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "16px"
        }}
      >
        ❌
      </button>
    </div>
  );
}

export default Goal;