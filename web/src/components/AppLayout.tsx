import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChatPage } from '../pages/ChatPage';
import { Icon } from './Icon';

export function AppLayout() {
  const { pathname } = useLocation();
  const isChat = pathname === '/';

  return (
    <div className={`app-shell${isChat ? ' app-shell-chat' : ''}`}>
      <a className="skip-link" href="#main-content">
        Ir al contenido
      </a>
      <aside className={`sidebar${isChat ? ' sidebar-chat' : ''}`}>
        <div className="sidebar-top">
          <h1 className="brand">Qatin</h1>
          <p className="brand-sub">Tickets, casos, evidencias</p>
          <nav className="nav">
            <NavLink to="/" end>
              <Icon name="chat" />
              Chat
            </NavLink>
            <NavLink to="/projects">
              <Icon name="folder" />
              Proyectos
            </NavLink>
            <NavLink to="/runs">
              <Icon name="runs" />
              Ejecuciones
            </NavLink>
            <NavLink to="/settings">
              <Icon name="gear" />
              Configuración
            </NavLink>
          </nav>
        </div>
        <div
          id="chat-sessions-root"
          className={isChat ? 'chat-sessions-slot' : 'chat-sessions-slot-hidden'}
        />
      </aside>
      <main id="main-content" className={`main${isChat ? ' main-chat' : ''}`} tabIndex={-1}>
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
