export default function Loading() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#fafafa",
        padding: "64px 5vw",
        fontFamily:
          "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <div style={{ maxWidth: 1440, margin: "0 auto" }}>
        <div className="skeleton title" />
        <div className="grid">
          <div className="skeleton card" />
          <div className="skeleton card" />
          <div className="skeleton card" />
        </div>
        <div className="skeleton panel" />
      </div>
      <style>{`
        * { box-sizing: border-box; }
        .skeleton { background: linear-gradient(90deg, #ececec 25%, #f5f5f5 50%, #ececec 75%); background-size: 200% 100%; animation: shimmer 1.4s infinite; border-radius: 18px; }
        .title { width: 360px; max-width: 80vw; height: 52px; margin-bottom: 48px; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
        .card { height: 152px; }
        .panel { height: 420px; margin-top: 32px; }
        @keyframes shimmer { to { background-position: -200% 0; } }
        @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
      `}</style>
    </main>
  );
}
