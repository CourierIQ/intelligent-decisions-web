import React from "react";
import { createRoot } from "react-dom/client";
import { BidLensWorkbench } from "./workbench";
import { BIDLENS_SAMPLE_ANALYSIS } from "./sample";
import { BIDLENS_PRODUCTS } from "./products";
import styles from "./bidlens.module.css";

function App() {
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#bidlens-workspace">Skip to BidLens workspace</a>
      <header className={styles.header}>
        <a className={styles.studioLink} href="/" aria-label="Intelligent Decisions home"><strong>Intelligent Decisions</strong></a>
        <div className={styles.productMark} aria-label="BidLens"><span className={styles.lensMark} aria-hidden="true"><i /></span><strong>BidLens</strong><small>RFP intelligence</small></div>
        <a className={styles.contactLink} href="mailto:development@intelligentdecisions.io">Talk to us <span aria-hidden="true">↗</span></a>
      </header>
      <BidLensWorkbench sample={BIDLENS_SAMPLE_ANALYSIS} products={BIDLENS_PRODUCTS} />
      <footer className={styles.footer}>
        <p>Decision support, not legal advice. Verify material requirements against the source RFP.</p>
        <div><a href="/">Intelligent Decisions</a><a href="/privacy/#bidlens">Privacy</a><a href="/terms/">Terms</a><a href="/support/">Support</a><a href="/contact/">Contact</a></div>
      </footer>
    </main>
  );
}

const root = document.getElementById("bidlens-root");
if (!root) throw new Error("BidLens root was not found.");
createRoot(root).render(<App />);
