/**
 * commsMessages.js — backend i18n catalog for OUTBOUND comms to profiles.
 *
 * The owner requirement: "The text messages and emails to existing profiles need
 * to be language aware, too." Each profile stores a preferred language (see
 * profileLanguage.getProfileLanguage). This catalog holds the localized copy for
 * the messages we send TO profiles, in all nine supported languages:
 *   en (English, default), es, ru, fr, uk, de, pt, hi, zh.
 *
 * SCOPE: this is the source of truth for COMMS copy only (SMS consent flow +
 * deadline / notification email + SMS). It is intentionally separate from the
 * frontend UI dictionaries in src/i18n/locales/*.json (those localize the app
 * UI, not server-sent messages). Do not hardcode/copy those JSONs here.
 *
 * KEYS:
 *   sms_consent_request      — the "is it ok to text you?" consent ask (SMS).
 *   sms_opt_in_confirm       — confirmation after someone replies YES (SMS).
 *   sms_opt_out_confirm      — confirmation after someone replies STOP (SMS).
 *   sms_unknown_reply        — neutral reply to a non-keyword inbound SMS.
 *   deadline_email_subject   — deadline reminder email subject.
 *   deadline_email_heading   — deadline reminder email H2 heading.
 *   deadline_email_body_*    — deadline reminder email body fragments.
 *   deadline_email_cta       — "View in GrantFlow" button label.
 *   deadline_email_footer    — opt-out footer line.
 *   deadline_sms             — deadline reminder SMS body.
 *   day_tomorrow / day_in_n  — relative-day phrasing used by email + SMS.
 *
 * COMPLIANCE: the literal keywords YES / STOP / START stay recognizable in every
 * language (STOP is a carrier keyword and must survive verbatim). The consent
 * copy keeps the "Msg & data rates may apply" + opt-out phrasing required by
 * TCPA/CTIA, localized around those fixed keywords.
 *
 * Interpolation: t(lang, key, vars) replaces {var} tokens. Missing key/lang
 * falls back to English; an entirely missing key returns the key itself.
 */

import { normalizeLanguageCode, DEFAULT_LANGUAGE } from '../../../shared/languages.js'

// Brand line reused across languages so the sender is always identifiable.
const BRAND = 'GrantFlow (Axiom Biolabs)'

export const COMMS_MESSAGES = Object.freeze({
  en: {
    sms_consent_request:
      `${BRAND}: we'd like to text you grant deadline & account notifications. ` +
      'Msg & data rates may apply. Reply YES to receive texts, or STOP to opt out.',
    sms_opt_in_confirm: "Thanks! You're now subscribed to GrantFlow texts. Reply STOP anytime to opt out.",
    sms_opt_out_confirm: "You've been unsubscribed from GrantFlow texts. Reply START to opt back in.",
    sms_unknown_reply: 'Reply YES to receive GrantFlow texts, or STOP to opt out.',

    day_tomorrow: 'tomorrow',
    day_in_n: 'in {days} days',

    deadline_email_subject: 'Deadline {dayLabel}: {grantTitle}',
    deadline_email_heading: 'Grant Deadline Approaching',
    deadline_email_body_intro: 'The deadline for {grantTitle} is {dayLabel} ({deadline}).',
    deadline_email_body_final: 'This is your final reminder. Make sure your application is ready to submit.',
    deadline_email_body_review: 'Log in to GrantFlow to review your application and submit before the deadline.',
    deadline_email_cta: 'View in GrantFlow',
    deadline_email_footer:
      "You're receiving this because you have deadline email reminders enabled in GrantFlow. " +
      'Update your preferences in Settings to opt out.',

    deadline_sms: 'GrantFlow: Deadline {dayLabel} for "{grantTitle}". Log in to review your application.',
  },

  es: {
    sms_consent_request:
      `${BRAND}: nos gustaría enviarte mensajes de texto con avisos de plazos de subvenciones y de tu cuenta. ` +
      'Pueden aplicarse tarifas de mensajes y datos. Responde YES para recibir textos, o STOP para darte de baja.',
    sms_opt_in_confirm: '¡Gracias! Ahora estás suscrito a los textos de GrantFlow. Responde STOP en cualquier momento para darte de baja.',
    sms_opt_out_confirm: 'Te has dado de baja de los textos de GrantFlow. Responde START para volver a suscribirte.',
    sms_unknown_reply: 'Responde YES para recibir textos de GrantFlow, o STOP para darte de baja.',

    day_tomorrow: 'mañana',
    day_in_n: 'en {days} días',

    deadline_email_subject: 'Plazo {dayLabel}: {grantTitle}',
    deadline_email_heading: 'Se acerca el plazo de la subvención',
    deadline_email_body_intro: 'El plazo para {grantTitle} es {dayLabel} ({deadline}).',
    deadline_email_body_final: 'Este es tu último recordatorio. Asegúrate de que tu solicitud esté lista para enviar.',
    deadline_email_body_review: 'Inicia sesión en GrantFlow para revisar tu solicitud y enviarla antes del plazo.',
    deadline_email_cta: 'Ver en GrantFlow',
    deadline_email_footer:
      'Recibes esto porque tienes activados los recordatorios de plazos por correo en GrantFlow. ' +
      'Actualiza tus preferencias en Configuración para darte de baja.',

    deadline_sms: 'GrantFlow: Plazo {dayLabel} para "{grantTitle}". Inicia sesión para revisar tu solicitud.',
  },

  ru: {
    sms_consent_request:
      `${BRAND}: мы хотели бы отправлять вам SMS с напоминаниями о сроках грантов и уведомлениями по аккаунту. ` +
      'Может взиматься плата за сообщения и данные. Ответьте YES, чтобы получать сообщения, или STOP, чтобы отказаться.',
    sms_opt_in_confirm: 'Спасибо! Вы подписаны на SMS от GrantFlow. Ответьте STOP в любой момент, чтобы отказаться.',
    sms_opt_out_confirm: 'Вы отписались от SMS GrantFlow. Ответьте START, чтобы снова подписаться.',
    sms_unknown_reply: 'Ответьте YES, чтобы получать SMS от GrantFlow, или STOP, чтобы отказаться.',

    day_tomorrow: 'завтра',
    day_in_n: 'через {days} дн.',

    deadline_email_subject: 'Срок {dayLabel}: {grantTitle}',
    deadline_email_heading: 'Приближается срок подачи на грант',
    deadline_email_body_intro: 'Срок для {grantTitle} наступает {dayLabel} ({deadline}).',
    deadline_email_body_final: 'Это последнее напоминание. Убедитесь, что ваша заявка готова к отправке.',
    deadline_email_body_review: 'Войдите в GrantFlow, чтобы проверить заявку и отправить её до истечения срока.',
    deadline_email_cta: 'Открыть в GrantFlow',
    deadline_email_footer:
      'Вы получили это письмо, потому что у вас включены напоминания о сроках по электронной почте в GrantFlow. ' +
      'Измените настройки в разделе «Настройки», чтобы отказаться.',

    deadline_sms: 'GrantFlow: Срок {dayLabel} для «{grantTitle}». Войдите, чтобы проверить заявку.',
  },

  fr: {
    sms_consent_request:
      `${BRAND} : nous aimerions vous envoyer par SMS les échéances de subventions et les notifications de compte. ` +
      'Des frais de messages et de données peuvent s\'appliquer. Répondez YES pour recevoir les SMS, ou STOP pour vous désabonner.',
    sms_opt_in_confirm: 'Merci ! Vous êtes maintenant abonné aux SMS de GrantFlow. Répondez STOP à tout moment pour vous désabonner.',
    sms_opt_out_confirm: 'Vous avez été désabonné des SMS de GrantFlow. Répondez START pour vous réabonner.',
    sms_unknown_reply: 'Répondez YES pour recevoir les SMS de GrantFlow, ou STOP pour vous désabonner.',

    day_tomorrow: 'demain',
    day_in_n: 'dans {days} jours',

    deadline_email_subject: 'Échéance {dayLabel} : {grantTitle}',
    deadline_email_heading: 'Échéance de subvention imminente',
    deadline_email_body_intro: 'L\'échéance pour {grantTitle} est {dayLabel} ({deadline}).',
    deadline_email_body_final: 'Ceci est votre dernier rappel. Assurez-vous que votre demande est prête à être soumise.',
    deadline_email_body_review: 'Connectez-vous à GrantFlow pour revoir votre demande et la soumettre avant l\'échéance.',
    deadline_email_cta: 'Voir dans GrantFlow',
    deadline_email_footer:
      'Vous recevez ce message car les rappels d\'échéances par e-mail sont activés dans GrantFlow. ' +
      'Modifiez vos préférences dans les Paramètres pour vous désabonner.',

    deadline_sms: 'GrantFlow : Échéance {dayLabel} pour « {grantTitle} ». Connectez-vous pour revoir votre demande.',
  },

  uk: {
    sms_consent_request:
      `${BRAND}: ми хотіли б надсилати вам SMS із нагадуваннями про терміни грантів та сповіщеннями облікового запису. ` +
      'Може стягуватися плата за повідомлення та дані. Відповідайте YES, щоб отримувати повідомлення, або STOP, щоб відмовитися.',
    sms_opt_in_confirm: 'Дякуємо! Ви підписані на SMS від GrantFlow. Відповідайте STOP будь-коли, щоб відмовитися.',
    sms_opt_out_confirm: 'Ви відписалися від SMS GrantFlow. Відповідайте START, щоб підписатися знову.',
    sms_unknown_reply: 'Відповідайте YES, щоб отримувати SMS від GrantFlow, або STOP, щоб відмовитися.',

    day_tomorrow: 'завтра',
    day_in_n: 'через {days} дн.',

    deadline_email_subject: 'Термін {dayLabel}: {grantTitle}',
    deadline_email_heading: 'Наближається термін подання на грант',
    deadline_email_body_intro: 'Термін для {grantTitle} настає {dayLabel} ({deadline}).',
    deadline_email_body_final: 'Це останнє нагадування. Переконайтеся, що вашу заявку готово до подання.',
    deadline_email_body_review: 'Увійдіть до GrantFlow, щоб переглянути заявку та подати її до завершення терміну.',
    deadline_email_cta: 'Відкрити в GrantFlow',
    deadline_email_footer:
      'Ви отримали це, оскільки у вас увімкнено нагадування про терміни електронною поштою в GrantFlow. ' +
      'Змініть налаштування в розділі «Налаштування», щоб відмовитися.',

    deadline_sms: 'GrantFlow: Термін {dayLabel} для «{grantTitle}». Увійдіть, щоб переглянути заявку.',
  },

  de: {
    sms_consent_request:
      `${BRAND}: Wir möchten Ihnen Benachrichtigungen zu Förderfristen und Ihrem Konto per SMS senden. ` +
      'Es können SMS- und Datengebühren anfallen. Antworten Sie mit YES, um SMS zu erhalten, oder mit STOP, um sich abzumelden.',
    sms_opt_in_confirm: 'Danke! Sie sind jetzt für GrantFlow-SMS angemeldet. Antworten Sie jederzeit mit STOP, um sich abzumelden.',
    sms_opt_out_confirm: 'Sie wurden von GrantFlow-SMS abgemeldet. Antworten Sie mit START, um sich wieder anzumelden.',
    sms_unknown_reply: 'Antworten Sie mit YES, um GrantFlow-SMS zu erhalten, oder mit STOP, um sich abzumelden.',

    day_tomorrow: 'morgen',
    day_in_n: 'in {days} Tagen',

    deadline_email_subject: 'Frist {dayLabel}: {grantTitle}',
    deadline_email_heading: 'Förderfrist rückt näher',
    deadline_email_body_intro: 'Die Frist für {grantTitle} ist {dayLabel} ({deadline}).',
    deadline_email_body_final: 'Dies ist Ihre letzte Erinnerung. Stellen Sie sicher, dass Ihr Antrag einreichbereit ist.',
    deadline_email_body_review: 'Melden Sie sich bei GrantFlow an, um Ihren Antrag zu prüfen und vor der Frist einzureichen.',
    deadline_email_cta: 'In GrantFlow ansehen',
    deadline_email_footer:
      'Sie erhalten dies, weil in GrantFlow E-Mail-Erinnerungen an Fristen aktiviert sind. ' +
      'Ändern Sie Ihre Einstellungen, um sich abzumelden.',

    deadline_sms: 'GrantFlow: Frist {dayLabel} für „{grantTitle}". Melden Sie sich an, um Ihren Antrag zu prüfen.',
  },

  pt: {
    sms_consent_request:
      `${BRAND}: gostaríamos de enviar mensagens de texto com avisos de prazos de subvenções e da sua conta. ` +
      'Podem aplicar-se tarifas de mensagens e dados. Responda YES para receber mensagens, ou STOP para cancelar.',
    sms_opt_in_confirm: 'Obrigado! Você agora está inscrito nas mensagens da GrantFlow. Responda STOP a qualquer momento para cancelar.',
    sms_opt_out_confirm: 'Você cancelou a inscrição nas mensagens da GrantFlow. Responda START para se inscrever novamente.',
    sms_unknown_reply: 'Responda YES para receber mensagens da GrantFlow, ou STOP para cancelar.',

    day_tomorrow: 'amanhã',
    day_in_n: 'em {days} dias',

    deadline_email_subject: 'Prazo {dayLabel}: {grantTitle}',
    deadline_email_heading: 'Prazo da subvenção se aproximando',
    deadline_email_body_intro: 'O prazo para {grantTitle} é {dayLabel} ({deadline}).',
    deadline_email_body_final: 'Este é o seu lembrete final. Verifique se a sua candidatura está pronta para envio.',
    deadline_email_body_review: 'Faça login na GrantFlow para revisar sua candidatura e enviá-la antes do prazo.',
    deadline_email_cta: 'Ver na GrantFlow',
    deadline_email_footer:
      'Você está recebendo isto porque tem os lembretes de prazo por e-mail ativados na GrantFlow. ' +
      'Atualize suas preferências em Configurações para cancelar.',

    deadline_sms: 'GrantFlow: Prazo {dayLabel} para "{grantTitle}". Faça login para revisar sua candidatura.',
  },

  hi: {
    sms_consent_request:
      `${BRAND}: हम आपको अनुदान की समय-सीमा और खाते की सूचनाएँ टेक्स्ट संदेश के रूप में भेजना चाहेंगे। ` +
      'संदेश और डेटा दरें लागू हो सकती हैं। संदेश पाने के लिए YES लिखकर भेजें, या ऑप्ट आउट करने के लिए STOP भेजें।',
    sms_opt_in_confirm: 'धन्यवाद! अब आप GrantFlow के टेक्स्ट संदेशों की सदस्यता ले चुके हैं। किसी भी समय ऑप्ट आउट करने के लिए STOP भेजें।',
    sms_opt_out_confirm: 'आपने GrantFlow के टेक्स्ट संदेशों की सदस्यता रद्द कर दी है। फिर से सदस्यता लेने के लिए START भेजें।',
    sms_unknown_reply: 'GrantFlow के टेक्स्ट संदेश पाने के लिए YES भेजें, या ऑप्ट आउट करने के लिए STOP भेजें।',

    day_tomorrow: 'कल',
    day_in_n: '{days} दिनों में',

    deadline_email_subject: 'समय-सीमा {dayLabel}: {grantTitle}',
    deadline_email_heading: 'अनुदान की समय-सीमा निकट है',
    deadline_email_body_intro: '{grantTitle} की समय-सीमा {dayLabel} ({deadline}) है।',
    deadline_email_body_final: 'यह आपका अंतिम अनुस्मारक है। सुनिश्चित करें कि आपका आवेदन जमा करने के लिए तैयार है।',
    deadline_email_body_review: 'अपने आवेदन की समीक्षा करने और समय-सीमा से पहले जमा करने के लिए GrantFlow में लॉग इन करें।',
    deadline_email_cta: 'GrantFlow में देखें',
    deadline_email_footer:
      'आपको यह इसलिए मिल रहा है क्योंकि आपने GrantFlow में ईमेल द्वारा समय-सीमा अनुस्मारक सक्षम किए हैं। ' +
      'ऑप्ट आउट करने के लिए सेटिंग्स में अपनी प्राथमिकताएँ अपडेट करें।',

    deadline_sms: 'GrantFlow: "{grantTitle}" के लिए समय-सीमा {dayLabel}। अपना आवेदन देखने के लिए लॉग इन करें।',
  },

  zh: {
    sms_consent_request:
      `${BRAND}：我们希望通过短信向您发送补助金截止日期和账户通知。` +
      '可能会产生短信和数据费用。回复 YES 接收短信，或回复 STOP 退订。',
    sms_opt_in_confirm: '谢谢！您已订阅 GrantFlow 短信。随时回复 STOP 即可退订。',
    sms_opt_out_confirm: '您已退订 GrantFlow 短信。回复 START 可重新订阅。',
    sms_unknown_reply: '回复 YES 接收 GrantFlow 短信，或回复 STOP 退订。',

    day_tomorrow: '明天',
    day_in_n: '{days} 天后',

    deadline_email_subject: '截止日期{dayLabel}：{grantTitle}',
    deadline_email_heading: '补助金截止日期临近',
    deadline_email_body_intro: '{grantTitle} 的截止日期是{dayLabel}（{deadline}）。',
    deadline_email_body_final: '这是最后的提醒。请确保您的申请已准备好提交。',
    deadline_email_body_review: '登录 GrantFlow 查看您的申请，并在截止日期前提交。',
    deadline_email_cta: '在 GrantFlow 中查看',
    deadline_email_footer:
      '您收到此邮件是因为您在 GrantFlow 中启用了截止日期邮件提醒。' +
      '在“设置”中更新您的偏好即可退订。',

    deadline_sms: 'GrantFlow：“{grantTitle}”的截止日期{dayLabel}。请登录查看您的申请。',
  },
})

/**
 * Interpolate {var} tokens from `vars` into a template string.
 * Leaves unknown tokens in place (so a typo is visible, not silently dropped).
 */
function interpolate(template, vars) {
  if (!vars || typeof template !== 'string') return template
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  )
}

/**
 * Localized comms-copy accessor.
 *   t(lang, key, vars?) -> string
 *
 * - lang is normalized to a supported code (defaults to English).
 * - if the key is missing in the chosen language, falls back to English.
 * - if the key is missing in English too, returns the key itself (loud, not blank).
 * - vars interpolates {token} placeholders.
 */
export function t(lang, key, vars) {
  const code = normalizeLanguageCode(lang)
  const table = COMMS_MESSAGES[code] || COMMS_MESSAGES[DEFAULT_LANGUAGE]
  const has = (tbl) => tbl && tbl[key] !== null && tbl[key] !== undefined
  let template = key // loud fallback: a missing key surfaces as itself, not blank
  if (has(table)) template = table[key]
  else if (has(COMMS_MESSAGES[DEFAULT_LANGUAGE])) template = COMMS_MESSAGES[DEFAULT_LANGUAGE][key]
  return interpolate(template, vars)
}

/**
 * Localized "relative day" phrase used by deadline email + SMS.
 * @returns {string} e.g. 'tomorrow' / 'in 3 days' (localized).
 */
export function dayLabel(lang, daysRemaining) {
  return daysRemaining === 1 ? t(lang, 'day_tomorrow') : t(lang, 'day_in_n', { days: daysRemaining })
}

export const SUPPORTED_COMMS_LANGUAGES = Object.freeze(Object.keys(COMMS_MESSAGES))
