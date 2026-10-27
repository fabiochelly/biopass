// Document hors écran : seul contexte d'une extension MV3 où l'on peut écrire dans le presse-papiers
// sans page au premier plan (raccourci « mot de passe généré »).
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== 'offscreen' || msg.type !== 'copy') return;
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', msg.text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  reply(document.execCommand('copy'));
});
