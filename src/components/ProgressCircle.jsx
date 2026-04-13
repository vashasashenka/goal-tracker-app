import React from "react";

function ProgressCircle({ progress }) {
  return (
    <div
      style={{
        width: "120px",
        height: "120px",
        borderRadius: "50%",
        background: `conic-gradient(#4CAF50 ${progress}%, #e0e0e0 ${progress}%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "20px",
        fontWeight: "bold",
      }}
    >
      {progress}%
    </div>
  );
}

export default ProgressCircle;