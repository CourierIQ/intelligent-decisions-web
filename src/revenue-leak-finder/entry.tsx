import React from "react";
import { createRoot } from "react-dom/client";
import { RevenueLeakFinder } from "./revenue-leak-finder";
import styles from "./revenue-leak-finder.module.css";

function BrandMark() {
  return <span className={`${styles["studio-monogram"]} studio-monogram`} aria-hidden="true">ID</span>;
}

function App() {
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#reconciliation-workspace">Skip to reconciliation workspace</a>
      <header className={styles.siteHeader}>
        <a className={styles.brand} href="/" aria-label="Intelligent Decisions home"><BrandMark /></a>
        <nav aria-label="Revenue Leak Finder navigation">
          <a href="#reconciliation-workspace">Reconcile</a>
          <a href="#method">Method</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <a className={styles.backLink} href="/">Intelligent Decisions <span aria-hidden="true">↗</span></a>
      </header>
      <RevenueLeakFinder />
      <footer className={styles.footer}>
        <BrandMark />
        <p>Revenue Leak Finder by Intelligent Decisions</p>
        <nav className={styles.legalLinks} aria-label="Legal and support navigation">
          <a href="/privacy/#revenue-leak-finder">Privacy</a>
          <a href="/terms/">Terms</a>
          <a href="/support/">Support</a>
          <a href="/contact/">Contact</a>
        </nav>
      </footer>
    </main>
  );
}

const root = document.getElementById("revenue-leak-app");
if (!root) throw new Error("Revenue Leak Finder root element was not found.");
createRoot(root).render(<App />);
