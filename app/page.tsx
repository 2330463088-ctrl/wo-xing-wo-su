export default function Home() {
  return (
    <main style={{ minHeight: "100vh", background: "#e9eeee" }}>
      <iframe
        title="我行我诉"
        src="/mobile-preview-v2.html"
        style={{
          display: "block",
          width: "100%",
          maxWidth: "480px",
          minHeight: "100vh",
          margin: "0 auto",
          border: 0,
          background: "#f5f8f8",
        }}
      />
    </main>
  );
}
