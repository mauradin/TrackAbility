/* =====================================================================
   TrackAbility — CONFIG
   Fill these in once. See README.md "Setup" for step-by-step instructions.
   This file is safe to commit since the app has no real security
   (URL-whitelisted for you + your friend only).
   ===================================================================== */

window.APP_CONFIG = {
  // --- Firebase (shared data store) -----------------------------------
  // Firebase console -> Project settings -> "Your apps" -> Web app -> Config
  firebase: {
    apiKey:            "AIzaSyDmIZrr_vAagDevyFpr5NQdbduWEyH1_Cg",
    authDomain:        "trackability-35d4e.firebaseapp.com",
    projectId:         "trackability-35d4e",
    storageBucket:     "trackability-35d4e.firebasestorage.app",
    messagingSenderId: "320541347708",
    appId:             "1:320541347708:web:2d689d3e03b5a620631ef9"
  },

  // --- EmailJS (nudge emails straight from the browser) ---------------
  // emailjs.com -> Account -> API Keys (public key),
  // Email Services -> Service ID, Email Templates -> Template ID.
  // Your template should accept these variables:
  //   {{to_email}} {{to_name}} {{from_name}} {{message}} {{days_behind}}
  emailjs: {
    publicKey:  "CGwR7FuE602AyOQMi",            // <- your public key (already set)
    serviceId:  "MarSaraColony",                // <- your EmailJS service (set)
    templateId: "AccountabilityPing",           // <- nudge template (already set)
    // OPTIONAL: a SEPARATE template for the "Push Feed" digest so it doesn't
    // look like the accountability nudge. Create a plain template in EmailJS
    // whose body is just {{subject}} + {{message}} and put its Template ID here.
    // Leave "" to reuse the nudge template above.
    feedTemplateId: ""
    // NOTE: your PRIVATE key is intentionally NOT here. It belongs only in
    // server-side code; putting it in the browser would let anyone send mail
    // through your account. The public key is all the browser SDK needs.
  },

  // Your display name — used as the sender name in nudge emails.
  myName: "Jesse"
};
