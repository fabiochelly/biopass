// BioPass — amorce du popup. Script classique, exécuté avant le chargement des modules : la demande au
// service worker (état, onglet, liste, premières icônes) part tout de suite, pendant que popup.js et
// core.js se chargent, au lieu d'attendre la fin de leur chargement.
window.bpBoot = chrome.runtime.sendMessage({ type: 'popup', first: 12 });
