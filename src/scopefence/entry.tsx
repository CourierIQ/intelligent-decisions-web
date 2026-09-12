import React from "react";
import { createRoot } from "react-dom/client";
import { ScopeFenceWorkspace } from "./workspace";
import styles from "./scopefence.module.css";

function App() {
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#scopefence-workspace">Skip to workspace</a>
      <header className={styles.siteHeader}>
        <a className={styles.idiBrand} href="/" aria-label="Intelligent Decisions home"><strong>ID</strong><span>Intelligent Decisions</span></a>
        <div className={styles.productName}><i aria-hidden="true" />ScopeFence</div>
        <nav aria-label="ScopeFence navigation"><a href="/#products">All products</a></nav>
      </header>
      <ScopeFenceWorkspace />
      <footer className={styles.footer}><p>ScopeFence is a planning aid, not legal advice.</p><a href="/">All Intelligent Decisions products</a></footer>
    </main>
  );
}

const root = document.getElementById("scopefence-root");
if (!root) throw new Error("ScopeFence root was not found.");
createRoot(root).render(<App />);
