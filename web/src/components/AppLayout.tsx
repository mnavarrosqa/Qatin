import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChatPage } from '../pages/ChatPage';

export function AppLayout() {
  const { pathname } = useLocation();
  const isChat = pathname === '/';

  return (
    <div className={`app-shell${isChat ? ' app-shell-chat' : ''}`}>
      <aside className={`sidebar${isChat ? ' sidebar-chat' : ''}`}>
        <div className="sidebar-top">
          <h1 className="brand">Qatin</h1>
          <p className="brand-sub">QA para tickets</p>
          <nav className="nav">
            <NavLink to="/" end>
              Chat
            </NavLink>
            <NavLink to="/projects">Proyectos</NavLink>
            <NavLink to="/runs">Ejecuciones</NavLink>
            <NavLink to="/settings">Configuración</NavLink>
          </nav>
        </div>
        <div
          id="chat-sessions-root"
          className={isChat ? 'chat-sessions-slot' : 'chat-sessions-slot-hidden'}
        />
      </aside>
      <main className={`main${isChat ? ' main-chat' : ''}`}>
        <div
          className={isChat ? 'chat-route' : 'chat-route-hidden'}
          aria-hidden={!isChat}
        >
          <ChatPage active={isChat} />
        </div>
        {!isChat ? <Outlet /> : null}
      </main>
    </div>
  );
}
