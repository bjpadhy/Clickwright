import { NavLink, Route, Routes } from "react-router-dom";
import RunView from "./pages/RunView";
import Chat from "./pages/Chat";
import History from "./pages/History";
import ContextBrowser from "./pages/ContextBrowser";

const tabs = [
  { to: "/", label: "Run", el: <RunView /> },
  { to: "/chat", label: "Chat", el: <Chat /> },
  { to: "/history", label: "History", el: <History /> },
  { to: "/context", label: "Context", el: <ContextBrowser /> },
];

export default function App() {
  return (
    <div className="min-h-screen">
      <nav className="flex gap-4 border-b px-6 py-3 text-sm">
        <span className="font-bold">Clickwright</span>
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? "font-semibold underline" : "opacity-70")}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        {tabs.map((t) => (
          <Route key={t.to} path={t.to} element={t.el} />
        ))}
      </Routes>
    </div>
  );
}
