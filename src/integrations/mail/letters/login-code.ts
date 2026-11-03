export type Language = "ru" | "en";

export type Letter = {
  subject: string;
  text: string;
};

export const loginCodeLetter: Record<Language, (code: string, minutes: number) => Letter> = {
  ru: (code, minutes) => ({
    subject: "Вход в Remember",
    text:
      `Введите этот код в приложении, чтобы войти:\n\n${code}\n\n` +
      `Код одноразовый и живёт ${minutes} мин. ` +
      `Если вход запрашивали не вы — просто удалите это письмо.`,
  }),
  en: (code, minutes) => ({
    subject: "Your sign-in code for Remember",
    text:
      `Here is the code that signs you in — type it into the app:\n\n${code}\n\n` +
      `It works once, and only within a ${minutes}-minute window. ` +
      `If you did not ask to sign in, ignore this email and the code expires on its own.`,
  }),
};
