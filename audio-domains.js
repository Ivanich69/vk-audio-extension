// Домены аудиосерверов: каждый пункт включает сам домен и ВСЕ его поддомены.
// Например, okcdn.ru покрывает vd546.okcdn.ru и другие номера серверов.
// После изменения: node scripts/sync-domains.mjs, затем перезагрузить расширение.
// Этот же список используется для автоматической проверки битрейта.
export const AUDIO_DOMAINS = Object.freeze([
  "vkuseraudio.ru",
  "okcdn.ru"
]);

export function isAudioHost(hostname) {
  const host = hostname.toLowerCase();
  return AUDIO_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}
