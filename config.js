// ============================================================
//  DUNGEON CRAWLER — configuración. Edita estos valores.
// ============================================================
window.CONFIG = {
  // Se muestra en la interfaz
  crawlerName: "Samu",           // nombre de quien recibe el regalo (aparece en el título)
  crawlerId: "4.827.116",        // texto decorativo, cualquier cadena

  // ¿Cuándo corre el calendario? El día N se desbloquea el N de diciembre de este año.
  decemberYear: 2026,

  // --- Notificaciones (push al móvil con ntfy.sh) -----------
  notify: {
    enabled: true,
    // 1. Instala la app gratuita "ntfy" en tu móvil.
    // 2. Suscríbete a un tema (topic) SECRETO difícil de adivinar.
    // 3. Pon aquí el MISMO tema. Las alertas llegan como notificaciones push.
    ntfyTopic: "dcc-samu-CAMBIAME-9f3a2",
    server: "https://ntfy.sh"
  }
};
