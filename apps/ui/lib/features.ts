// Tant qu'une feature n'est pas lancée, son flag limite l'accès anticipé.
// Passer la constante à `true` la rend à tout le monde et réveille ce qui va avec.
// Gates the Desktop button of the agent sheet. What an agent does with its screen (the computer
// tools, a takeover asked in its chat) is gated by DESKTOP_RELEASED on the engine.
export const COMPUTER_RELEASED = true
// Gates LinkedIn Pro, the first paid app: its card in the catalogue, its slots in the billing and
// every server action that connects an account or buys a slot.
export const LINKEDIN_PRO_RELEASED = true
// Gates WhatsApp Pro, the second paid app, like LINKEDIN_PRO_RELEASED gates the first.
export const WHATSAPP_PRO_RELEASED = true
