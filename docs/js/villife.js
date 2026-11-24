(() => {
  const languageButton = document.querySelector(".language-switch");
  let language = localStorage.getItem("villife-site-language") === "ru" ? "ru" : "en";

  function applyLanguage() {
    document.documentElement.lang = language;
    document.querySelectorAll("[data-en][data-ru]").forEach(element => {
      element.innerHTML = element.dataset[language];
    });
    languageButton.textContent = language === "en" ? "RU" : "EN";
    languageButton.setAttribute("aria-label", language === "en" ? "Switch to Russian" : "Switch to English");
    document.title = language === "en" ? "Villife — Find your sound" : "Villife — Найди своё звучание";
  }

  languageButton.addEventListener("click", () => {
    language = language === "en" ? "ru" : "en";
    localStorage.setItem("villife-site-language", language);
    applyLanguage();
  });

  document.querySelector("#year").textContent = new Date().getFullYear();

  const revealItems = document.querySelectorAll(".intro-section, .feature-card, .window-copy, .windows-art, .about-body");
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    revealItems.forEach(element => {
      element.classList.add("reveal");
      observer.observe(element);
    });
  }

  applyLanguage();
})();
