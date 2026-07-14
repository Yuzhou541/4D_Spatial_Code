(() => {
  const buttons = Array.from(document.querySelectorAll('[data-result-filter]'));
  const cards = Array.from(document.querySelectorAll('.sample-card[data-dimension]'));
  const count = document.querySelector('#visibleResultCount');

  function applyFilter(filter) {
    let visible = 0;
    cards.forEach((card) => {
      const show = filter === 'all' || card.dataset.dimension === filter;
      card.hidden = !show;
      if (show) visible += 1;
    });
    buttons.forEach((button) => {
      const active = button.dataset.resultFilter === filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (count) count.textContent = `${visible} interactive results`;
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => applyFilter(button.dataset.resultFilter || 'all'));
  });

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.sample-media video').forEach((video) => {
    const card = video.closest('.sample-card');
    if (!card || reducedMotion) return;
    const play = () => video.play().catch(() => {});
    const pause = () => {
      video.pause();
      video.currentTime = 0;
    };
    card.addEventListener('pointerenter', play);
    card.addEventListener('pointerleave', pause);
    card.addEventListener('focusin', play);
    card.addEventListener('focusout', pause);
  });

  const heroVideo = document.querySelector('.hero-media');
  if (heroVideo instanceof HTMLVideoElement) heroVideo.playbackRate = 0.5;
})();
