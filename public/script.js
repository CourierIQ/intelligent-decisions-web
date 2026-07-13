"use strict";

// Preserve the site's existing smooth anchor behavior.
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const targetId = link.getAttribute("href");

    if (!targetId || targetId === "#") {
      return;
    }

    const target = document.querySelector(targetId);

    if (!target) {
      return;
    }

    event.preventDefault();
    target.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
});

const betaModal = document.querySelector("#beta-access-modal");

if (betaModal) {
  const betaPanel = betaModal.querySelector(".beta-modal-panel");
  const betaForm = betaModal.querySelector("#beta-access-form");
  const betaFormView = betaModal.querySelector("[data-beta-form-view]");
  const betaSuccess = betaModal.querySelector("[data-beta-success]");
  const betaSuccessHeading = betaSuccess.querySelector("h2");
  const betaStatus = betaModal.querySelector("[data-beta-form-status]");
  const betaSubmit = betaModal.querySelector("[data-beta-submit]");
  const platformError = betaModal.querySelector("[data-platform-error]");
  const platformInputs = [
    ...betaModal.querySelectorAll('input[name="delivery_platforms"]'),
  ];
  const interestInput = betaModal.querySelector("#beta-interest");
  const interestCount = betaModal.querySelector("[data-interest-count]");
  const contactEmailInput = betaModal.querySelector("#beta-email");
  const googlePlayEmailInput = betaModal.querySelector(
    "#beta-google-play-email",
  );
  const openButtons = [...document.querySelectorAll("[data-beta-access-open]")];
  const closeButtons = [...betaModal.querySelectorAll("[data-beta-access-close]")];

  let lastFocusedElement = null;
  let turnstileWidgetId = null;
  let turnstileToken = "";
  let turnstileRenderTimer = null;
  let turnstileRenderAttempts = 0;
  let googlePlayEmailEdited = false;

  const focusableSelector = [
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function setStatus(message = "", state = "error") {
    betaStatus.textContent = message;

    if (message) {
      betaStatus.dataset.state = state;
    } else {
      delete betaStatus.dataset.state;
    }
  }

  function validatePlatforms(showMessage = false) {
    const hasPlatform = platformInputs.some((input) => input.checked);
    const firstPlatform = platformInputs[0];

    if (firstPlatform) {
      firstPlatform.setCustomValidity(
        hasPlatform ? "" : "Select at least one delivery platform.",
      );
    }

    platformError.textContent =
      !hasPlatform && showMessage
        ? "Select at least one delivery platform."
        : "";

    return hasPlatform;
  }

  function resetTurnstile() {
    turnstileToken = "";

    if (window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
  }

  function renderTurnstile() {
    if (turnstileWidgetId !== null || betaModal.getAttribute("aria-hidden") === "true") {
      return;
    }

    if (!window.turnstile) {
      turnstileRenderAttempts += 1;

      if (turnstileRenderAttempts >= 100) {
        setStatus("Verification could not load. Refresh the page and try again.");
        return;
      }

      window.clearTimeout(turnstileRenderTimer);
      turnstileRenderTimer = window.setTimeout(renderTurnstile, 100);
      return;
    }

    turnstileWidgetId = window.turnstile.render("#beta-turnstile", {
      sitekey: "0x4AAAAAADzePhY2Hgvp3XUu",
      theme: "dark",
      size: "flexible",
      action: "beta_access",
      callback(token) {
        turnstileToken = token;
        if (betaStatus.textContent.includes("verification")) {
          setStatus();
        }
      },
      "expired-callback"() {
        turnstileToken = "";
        setStatus("Verification expired. Please complete it again.");
      },
      "error-callback"() {
        turnstileToken = "";
        setStatus("Verification could not load. Refresh the page and try again.");
      },
    });
  }

  function resetModalState() {
    betaForm.reset();
    googlePlayEmailEdited = false;
    betaForm.hidden = false;
    betaFormView.hidden = false;
    betaSuccess.hidden = true;
    betaSubmit.disabled = false;
    betaSubmit.textContent = "Submit Request";
    interestCount.textContent = "0";
    platformError.textContent = "";
    setStatus();
    resetTurnstile();
  }

  function openBetaModal(event) {
    if (event) {
      event.preventDefault();
    }

    lastFocusedElement = document.activeElement;
    betaModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("beta-modal-open");
    turnstileRenderAttempts = 0;

    if (window.turnstile && turnstileWidgetId !== null) {
      resetTurnstile();
    } else {
      renderTurnstile();
    }

    window.requestAnimationFrame(() => {
      betaModal.querySelector(".beta-modal-close")?.focus();
    });
  }

  function closeBetaModal() {
    betaModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("beta-modal-open");
    window.clearTimeout(turnstileRenderTimer);

    if (lastFocusedElement instanceof HTMLElement) {
      lastFocusedElement.focus();
    }

    window.setTimeout(resetModalState, 180);
  }

  openButtons.forEach((button) => {
    button.addEventListener("click", openBetaModal);
  });

  closeButtons.forEach((button) => {
    button.addEventListener("click", closeBetaModal);
  });

  betaModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeBetaModal();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = [
      ...betaPanel.querySelectorAll(focusableSelector),
    ].filter((element) => !element.hidden && element.offsetParent !== null);

    if (!focusableElements.length) {
      return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  platformInputs.forEach((input) => {
    input.addEventListener("change", () => validatePlatforms(false));
  });

  interestInput.addEventListener("input", () => {
    interestCount.textContent = String(interestInput.value.length);
  });

  contactEmailInput.addEventListener("input", () => {
    if (!googlePlayEmailEdited) {
      googlePlayEmailInput.value = contactEmailInput.value;
    }
  });

  googlePlayEmailInput.addEventListener("input", () => {
    googlePlayEmailEdited =
      googlePlayEmailInput.value.trim().toLowerCase() !==
      contactEmailInput.value.trim().toLowerCase();
  });

  betaForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus();

    if (!googlePlayEmailInput.value.trim()) {
      googlePlayEmailInput.value = contactEmailInput.value;
    }

    const platformsValid = validatePlatforms(true);

    if (!betaForm.checkValidity() || !platformsValid) {
      betaForm.reportValidity();
      return;
    }

    if (!turnstileToken) {
      setStatus("Complete the verification before submitting.");
      return;
    }

    const formData = new FormData(betaForm);
    const payload = {
      first_name: formData.get("first_name"),
      email: formData.get("email"),
      google_play_email: formData.get("google_play_email"),
      state: formData.get("state"),
      android_device: formData.get("android_device"),
      delivery_platforms: formData.getAll("delivery_platforms"),
      weekly_deliveries: formData.get("weekly_deliveries"),
      interest_reason: formData.get("interest_reason"),
      consent: formData.get("consent") === "on",
      website: formData.get("website"),
      turnstile_token: turnstileToken,
    };

    betaSubmit.disabled = true;
    betaSubmit.textContent = "Submitting…";
    setStatus("Submitting your request…", "working");

    try {
      const response = await fetch("/api/beta-access", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => null);

      if (!response.ok || !result?.success) {
        throw new Error(
          result?.message || "Your request could not be submitted. Please try again.",
        );
      }

      betaForm.hidden = true;
      betaFormView.hidden = true;
      betaSuccess.hidden = false;
      betaSuccessHeading.focus();
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Your request could not be submitted. Please try again.",
      );
      betaSubmit.disabled = false;
      betaSubmit.textContent = "Submit Request";
      resetTurnstile();
    }
  });
}

const courierIqShowcase = document.querySelector("[data-courieriq-showcase]");

if (courierIqShowcase) {
  const viewport = courierIqShowcase.querySelector("[data-showcase-viewport]");
  const slides = [
    ...courierIqShowcase.querySelectorAll("[data-showcase-slide]"),
  ];
  const dots = [...courierIqShowcase.querySelectorAll("[data-showcase-dot]")];
  const previousButton = courierIqShowcase.querySelector(
    "[data-showcase-previous]",
  );
  const nextButton = courierIqShowcase.querySelector("[data-showcase-next]");

  let activeIndex = 0;
  let scrollFrame = null;

  function setActiveSlide(index, moveViewport = false) {
    const nextIndex = Math.max(0, Math.min(index, slides.length - 1));
    activeIndex = nextIndex;

    slides.forEach((slide, slideIndex) => {
      const isActive = slideIndex === activeIndex;
      slide.toggleAttribute("inert", !isActive);
      slide.setAttribute("aria-hidden", String(!isActive));
    });

    dots.forEach((dot, dotIndex) => {
      const isActive = dotIndex === activeIndex;
      dot.classList.toggle("is-active", isActive);

      if (isActive) {
        dot.setAttribute("aria-current", "true");
      } else {
        dot.removeAttribute("aria-current");
      }
    });

    previousButton.disabled = activeIndex === 0;
    nextButton.disabled = activeIndex === slides.length - 1;

    if (moveViewport) {
      viewport.scrollTo({
        left: slides[activeIndex].offsetLeft,
        behavior: "smooth",
      });
    }
  }

  function updateFromScroll() {
    scrollFrame = null;

    const viewportCenter = viewport.scrollLeft + viewport.clientWidth / 2;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;

    slides.forEach((slide, index) => {
      const slideCenter = slide.offsetLeft + slide.offsetWidth / 2;
      const distance = Math.abs(viewportCenter - slideCenter);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });

    if (closestIndex !== activeIndex) {
      setActiveSlide(closestIndex);
    }
  }

  previousButton.addEventListener("click", () => {
    setActiveSlide(activeIndex - 1, true);
  });

  nextButton.addEventListener("click", () => {
    setActiveSlide(activeIndex + 1, true);
  });

  dots.forEach((dot, index) => {
    dot.addEventListener("click", () => {
      setActiveSlide(index, true);
    });
  });

  viewport.addEventListener(
    "scroll",
    () => {
      if (scrollFrame !== null) {
        cancelAnimationFrame(scrollFrame);
      }

      scrollFrame = requestAnimationFrame(updateFromScroll);
    },
    { passive: true },
  );

  viewport.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveSlide(activeIndex - 1, true);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setActiveSlide(activeIndex + 1, true);
    }
  });

  window.addEventListener("resize", () => {
    viewport.scrollLeft = slides[activeIndex].offsetLeft;
  });

  setActiveSlide(0);
}
