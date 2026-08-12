import { NavLink, Outlet } from 'react-router-dom';

export function AppLayout() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1 className="brand">Qatin</h1>
        <p className="brand-sub">Agente de QA para tickets y flujos</p>
        <nav className="nav">
          <NavLink to="/" end>
            Chat
          </NavLink>
          <NavLink to="/projects">Proyectos</NavLink>
          <NavLink to="/runs">Ejecuciones</NavLink>
          <NavLink to="/settings">Configuración</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
