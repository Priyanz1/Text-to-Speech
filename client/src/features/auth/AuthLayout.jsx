/** The shared frame for the five auth screens, so each page is just its form. */
export function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <main className="shell">
      <header className="header">
        <h1>AI Text&#8209;to&#8209;Speech</h1>
        <p className="subtitle">{subtitle}</p>
      </header>

      <section className="card">
        <div className="card-head">
          <h2>{title}</h2>
        </div>

        {children}
      </section>

      {footer ? <footer className="footer">{footer}</footer> : null}
    </main>
  );
}
