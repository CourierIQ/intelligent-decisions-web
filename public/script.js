"use strict";

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const targetId = link.getAttribute("href");

    if (!targetId || targetId === "#") return;

    const target = document.querySelector(targetId);
    if (!target) return;

    event.preventDefault();

    if (
      targetId === "#courieriq" &&
      window.matchMedia("(max-width: 820px)").matches
    ) {
      const mobileHeaderOffset = 102;

      const targetTop =
        target.getBoundingClientRect().top +
        window.scrollY -
        mobileHeaderOffset;

      window.scrollTo({
        top: targetTop,
        behavior: "smooth",
      });

      return;
    }

    target.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
});
