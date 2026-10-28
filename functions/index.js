const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {onDocumentUpdated, onDocumentCreated} = require('firebase-functions/v2/firestore');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();

const REGION = 'europe-west1';
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
const gmailUser = defineSecret('GMAIL_USER');
const gmailAppPassword = defineSecret('GMAIL_APP_PASSWORD');

function getStripe() {
  return new Stripe(stripeSecretKey.value(), { apiVersion: '2024-06-20' });
}

function cleanPhone(p) {
  return (p || '').replace(/[^0-9]/g, '');
}

// Même logique que isAdmin() dans firestore.rules : le compte propriétaire
// (UID codé en dur) ou un UID listé dans la collection "admins".
const OWNER_UID = 'pn4WsdLN1gWrwIwMewMPumiRstj1';
async function isAdminUid(uid) {
  if (!uid) return false;
  if (uid === OWNER_UID) return true;
  const snap = await db.collection('admins').doc(uid).get();
  return snap.exists;
}

// Retrouve le compte associé à un numéro de téléphone (pour l'email et les
// notifications push, toutes deux déclenchées côté serveur).
async function findAccountByPhone(phone) {
  const snap = await db.collection('accounts').where('phoneClean', '==', cleanPhone(phone)).limit(1).get();
  if (snap.empty) return null;
  return { ref: snap.docs[0].ref, data: snap.docs[0].data() };
}

async function findEmailByPhone(phone) {
  const account = await findAccountByPhone(phone);
  return (account && account.data.email) || null;
}

// Envoie une notification push façon messagerie (titre = nom de
// l'expéditeur, corps = aperçu du message) — jamais une bannière générique
// style VTC. Les jetons invalides (désinstallation, permission révoquée...)
// sont retirés du compte au passage.
async function sendPush(phone, { title, body, url, tag }) {
  const account = await findAccountByPhone(phone);
  if (!account) { console.log('sendPush: aucun compte trouvé pour', phone); return; }
  const tokens = account.data.fcmTokens;
  if (!tokens || tokens.length === 0) { console.log('sendPush: compte trouvé mais aucun fcmToken pour', phone); return; }
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      data: { title, body, url: url || APP_URL, tag: tag || '' },
    });
    console.log(`sendPush: ${response.successCount}/${tokens.length} envoi(s) réussi(s) pour ${phone}`);
    response.responses.forEach((r) => { if (!r.success) console.log('sendPush erreur:', r.error && r.error.code, r.error && r.error.message); });
    const invalidTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(r.error && r.error.code)) {
        invalidTokens.push(tokens[i]);
      }
    });
    if (invalidTokens.length > 0) {
      await account.ref.set({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens) }, { merge: true });
    }
  } catch (err) {
    console.error('Échec notification push à', phone, err.message);
  }
}

// Envoie un email simple via le compte Gmail de Baraka GP (mot de passe
// d'application, pas le vrai mot de passe du compte). N'importe quelle
// erreur d'envoi est avalée : un email qui ne part pas ne doit jamais faire
// échouer l'action qui l'a déclenché (acceptation, paiement...).
async function sendEmail(to, subject, html) {
  if (!to) return;
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser.value(), pass: gmailAppPassword.value() },
    });
    await transporter.sendMail({
      from: `Baraka GP <${gmailUser.value()}>`,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error('Échec envoi email à', to, err.message);
  }
}

const EMAIL_SECRETS = [gmailUser, gmailAppPassword];
const APP_URL = 'https://baraka-gp.github.io/baraka-gp/index.html';
const ADMIN_URL = 'https://baraka-gp.github.io/baraka-gp/admin.html';

// Envoie un email à l'admin (compte propriétaire) — pour le prévenir d'un
// nouvel élément à modérer plutôt qu'il doive penser à revérifier
// admin.html régulièrement. Récupère son email depuis Firebase Auth plutôt
// que de le coder en dur ici.
async function notifyAdmin(subject, html) {
  try {
    const user = await admin.auth().getUser(OWNER_UID);
    if (user.email) await sendEmail(user.email, subject, html);
  } catch (err) {
    console.error('notifyAdmin: échec', err.message);
  }
}

// Découpe un nom complet en prénom / nom, pour pré-remplir Stripe avec ce
// qu'on a déjà collecté à l'inscription (évite de ressaisir l'identité).
function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined };
}

// Crée (si besoin) le compte Stripe Express d'un voyageur et renvoie son id
// — partagé par les deux façons de compléter sa fiche (identité, IBAN) :
// lien Stripe classique (redirection) ou composant intégré (sur place).
async function getOrCreateExpressAccount(stripe, phone, name, email, phoneE164) {
  const profileRef = db.collection('profiles').doc(phone);
  const profileSnap = await profileRef.get();
  let accountId = profileSnap.exists ? profileSnap.data().stripeAccountId : null;
  if (!accountId) {
    const { firstName, lastName } = splitName(name);
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'FR',
      capabilities: { transfers: { requested: true } },
      business_type: 'individual',
      email: email || undefined,
      // Sans ça, Stripe laisse l'inscription vide de contexte et peut
      // reprendre l'adresse du site de la plateforme (Baraka GP) comme si
      // c'était l'activité du voyageur lui-même — ce qui donnait
      // l'impression que ce formulaire s'adressait au créateur de l'appli
      // plutôt qu'à n'importe quel voyageur.
      business_profile: {
        product_description: 'Transport de colis entre particuliers via l\'application Baraka GP',
        mcc: '4789',
      },
      // Pré-remplit ce qu'on a déjà (saisi à l'inscription dans l'appli),
      // pour que le voyageur n'ait pas à le retaper sur le formulaire Stripe.
      // Stripe exige le format international (+33...) : le numéro local
      // nettoyé (ex. "0626141733") est rejeté comme "invalid phone number".
      individual: {
        first_name: firstName,
        last_name: lastName,
        email: email || undefined,
        phone: phoneE164 || undefined,
      },
    });
    accountId = account.id;
    await profileRef.set({ stripeAccountId: accountId }, { merge: true });
  }
  return accountId;
}

// Lien d'inscription Stripe classique (redirection hors de l'appli) — gardé
// en repli si le composant intégré (createAccountSession) ne se charge pas.
exports.createConnectOnboardingLink = onCall({ secrets: [stripeSecretKey], region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise');
  const phone = cleanPhone(request.data && request.data.phone);
  if (!phone) throw new HttpsError('invalid-argument', 'Numéro manquant');
  const name = request.data && request.data.name;
  const email = request.data && request.data.email;
  const phoneE164 = request.auth.token.phone_number || undefined;

  try {
    const stripe = getStripe();
    const accountId = await getOrCreateExpressAccount(stripe, phone, name, email, phoneE164);

    const origin = (request.data && request.data.origin) || 'https://baraka-gp.github.io/baraka-gp';
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/index.html?stripe=refresh`,
      return_url: `${origin}/index.html?stripe=return`,
      type: 'account_onboarding',
    });

    return { url: accountLink.url };
  } catch (err) {
    console.error('createConnectOnboardingLink a échoué pour', phone, ':', err.message);
    throw new HttpsError('internal', err.message);
  }
});

// Jeton pour afficher le formulaire Stripe directement dans la page (composant
// intégré "account onboarding"), sans rediriger hors de l'appli.
exports.createAccountSession = onCall({ secrets: [stripeSecretKey], region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise');
  const phone = cleanPhone(request.data && request.data.phone);
  if (!phone) throw new HttpsError('invalid-argument', 'Numéro manquant');
  const name = request.data && request.data.name;
  const email = request.data && request.data.email;
  const phoneE164 = request.auth.token.phone_number || undefined;

  try {
    const stripe = getStripe();
    const accountId = await getOrCreateExpressAccount(stripe, phone, name, email, phoneE164);

    const accountSession = await stripe.accountSessions.create({
      account: accountId,
      components: {
        account_onboarding: { enabled: true },
      },
    });

    return { clientSecret: accountSession.client_secret };
  } catch (err) {
    console.error('createAccountSession a échoué pour', phone, ':', err.message);
    throw new HttpsError('internal', err.message);
  }
});

// Crée un PaymentIntent pour une commande : l'argent est prélevé et retenu
// sur le solde de la plateforme (aucune destination définie ici), il ne
// sera reversé au voyageur qu'à la confirmation de la livraison —
// voir transferToTraveler ci-dessous.
exports.createPaymentIntent = onCall({ secrets: [stripeSecretKey], region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise');
  const orderId = request.data && request.data.orderId;
  if (!orderId) throw new HttpsError('invalid-argument', 'Commande manquante');

  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError('not-found', 'Commande introuvable');
  const order = orderSnap.data();
  if (order.status !== 'accepted') {
    throw new HttpsError('failed-precondition', "Cette commande ne peut pas être payée dans son état actuel");
  }

  const amountCents = Math.round((order.priceTotal || 0) * 100);
  if (amountCents <= 0) throw new HttpsError('failed-precondition', 'Montant invalide');

  const stripe = getStripe();
  let paymentIntent;
  if (order.stripePaymentIntentId) {
    const existing = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
    if (existing.status === 'succeeded') {
      // Le paiement a déjà réellement réussi côté Stripe (webhook pas encore
      // traité, ou raté) : on ne peut pas modifier un paiement terminé, donc
      // on répare directement la commande au lieu d'échouer.
      const pickupCode = order.pickupCode || String(Math.floor(1000 + Math.random() * 9000));
      await orderRef.set({ status: 'paid', pickupCode, paidAt: order.paidAt || Date.now() }, { merge: true });
      throw new HttpsError('already-exists', 'DEJA_PAYE');
    }
    if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existing.status)) {
      paymentIntent = await stripe.paymentIntents.update(order.stripePaymentIntentId, { amount: amountCents });
    } else {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'eur',
        metadata: { orderId },
        automatic_payment_methods: { enabled: true },
      });
      await orderRef.set({ stripePaymentIntentId: paymentIntent.id }, { merge: true });
    }
  } else {
    paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'eur',
      metadata: { orderId },
      automatic_payment_methods: { enabled: true },
    });
    await orderRef.set({ stripePaymentIntentId: paymentIntent.id }, { merge: true });
  }

  return { clientSecret: paymentIntent.client_secret };
});

// Webhook Stripe : seule source de vérité pour confirmer qu'un paiement a
// réellement eu lieu (jamais le client, qui pourrait mentir).
exports.stripeWebhook = onRequest({ secrets: [stripeSecretKey, stripeWebhookSecret], region: REGION }, async (req, res) => {
  const stripe = getStripe();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], stripeWebhookSecret.value());
  } catch (err) {
    res.status(400).send(`Signature invalide: ${err.message}`);
    return;
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const orderId = pi.metadata && pi.metadata.orderId;
    if (orderId) {
      const orderRef = db.collection('orders').doc(orderId);
      const snap = await orderRef.get();
      if (snap.exists && snap.data().status === 'accepted') {
        const pickupCode = String(Math.floor(1000 + Math.random() * 9000));
        await orderRef.set({ status: 'paid', pickupCode, paidAt: Date.now() }, { merge: true });
      }
    }
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    const matches = await db.collection('profiles').where('stripeAccountId', '==', account.id).limit(1).get();
    if (!matches.empty) {
      const onboarded = !!(account.details_submitted && account.charges_enabled);
      await matches.docs[0].ref.set({ stripeOnboarded: onboarded }, { merge: true });
    }
  }

  res.json({ received: true });
});

// Dès qu'une commande passe à "completed" (réception confirmée par le
// destinataire ou le voyageur), on reverse au voyageur sa part (priceNet),
// une seule fois — jamais avant, c'est tout l'intérêt de la retenue.
// Partagé par le déclenchement automatique (transferToTraveler) et le
// réessai manuel depuis admin.html (retryTransfer) — même logique, pour ne
// jamais avoir deux façons différentes de faire le même virement.
async function performTransfer(orderId, orderRef, order) {
  if (order.transferred) return { alreadyDone: true };
  const gpPhone = cleanPhone(order.gpPhone);
  const profileSnap = await db.collection('profiles').doc(gpPhone).get();
  const stripeAccountId = profileSnap.exists ? profileSnap.data().stripeAccountId : null;
  if (!stripeAccountId) {
    const message = "Le voyageur n'a pas de compte Stripe configuré";
    await orderRef.set({ transferError: message }, { merge: true });
    return { error: message };
  }

  const stripe = getStripe();
  const amountCents = Math.round((order.priceNet || 0) * 100);
  let transfer;
  try {
    transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'eur',
      destination: stripeAccountId,
      transfer_group: orderId,
      metadata: { orderId },
    });
    await orderRef.set({ transferred: true, transferId: transfer.id, transferredAt: Date.now(), transferError: admin.firestore.FieldValue.delete() }, { merge: true });
  } catch (err) {
    await orderRef.set({ transferError: err.message }, { merge: true });
    return { error: err.message };
  }

  // On essaie ensuite de verser cette somme instantanément sur le compte
  // bancaire du voyageur (quelques minutes, contre une petite commission
  // Stripe prélevée sur ce versement). Si son compte n'y est pas éligible,
  // on ne bloque pas : le virement automatique quotidien de Stripe prendra
  // le relais tout seul (aucune action à faire ici).
  try {
    const payout = await stripe.payouts.create(
      { amount: amountCents, currency: 'eur', method: 'instant' },
      { stripeAccount: stripeAccountId }
    );
    await orderRef.set({ instantPayoutId: payout.id }, { merge: true });
  } catch (err) {
    console.warn('Virement instantané indisponible pour', stripeAccountId, ':', err.message);
  }

  return { transferId: transfer.id };
}

exports.transferToTraveler = onDocumentUpdated({ document: 'orders/{orderId}', secrets: [stripeSecretKey], region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === 'completed' || after.status !== 'completed') return;
  if (after.transferred) return;
  if (!after.gpPhone || !after.priceNet) return;
  await performTransfer(event.params.orderId, event.data.after.ref, after);
});

// Réessaie manuellement un virement qui a échoué (ex. le voyageur a
// configuré son compte Stripe après coup) — bouton "Réessayer le virement"
// dans admin.html, pour éviter d'avoir à faire un virement à la main
// depuis le tableau de bord Stripe.
exports.retryTransfer = onCall({ secrets: [stripeSecretKey], region: REGION }, async (request) => {
  if (!request.auth || !(await isAdminUid(request.auth.uid))) {
    throw new HttpsError('permission-denied', 'Réservé aux administrateurs');
  }
  const orderId = request.data && request.data.orderId;
  if (!orderId) throw new HttpsError('invalid-argument', 'Commande manquante');
  const orderRef = db.collection('orders').doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable');
  const order = snap.data();
  if (order.status !== 'completed') throw new HttpsError('failed-precondition', "Cette commande n'est pas terminée");
  const result = await performTransfer(orderId, orderRef, order);
  if (result.error) throw new HttpsError('internal', result.error);
  return result;
});

// Rembourse un client (admin uniquement), via un vrai remboursement Stripe
// sur le paiement d'origine. Refusé si le voyageur a déjà été payé (le
// transfert Stripe n'est pas automatiquement annulé par un remboursement) —
// dans ce cas, un remboursement doit être géré manuellement par l'admin.
exports.refundOrder = onCall({ secrets: [stripeSecretKey], region: REGION }, async (request) => {
  if (!request.auth || !(await isAdminUid(request.auth.uid))) {
    throw new HttpsError('permission-denied', 'Réservé aux administrateurs');
  }
  const orderId = request.data && request.data.orderId;
  if (!orderId) throw new HttpsError('invalid-argument', 'Commande manquante');

  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError('not-found', 'Commande introuvable');
  const order = orderSnap.data();

  if (!order.stripePaymentIntentId) throw new HttpsError('failed-precondition', "Cette commande n'a pas été payée via Stripe");
  if (order.refunded) throw new HttpsError('failed-precondition', 'Cette commande a déjà été remboursée');
  if (order.transferred) throw new HttpsError('failed-precondition', "Le voyageur a déjà été payé pour cette commande — remboursement manuel requis depuis Stripe");

  const stripe = getStripe();
  try {
    const refund = await stripe.refunds.create({ payment_intent: order.stripePaymentIntentId });
    await orderRef.set({ refunded: true, refundId: refund.id, refundedAt: Date.now(), refundError: admin.firestore.FieldValue.delete() }, { merge: true });
    return { refundId: refund.id };
  } catch (err) {
    await orderRef.set({ refundError: err.message }, { merge: true });
    throw new HttpsError('internal', err.message);
  }
});

// Suppression de compte à la demande de l'utilisateur lui-même (droit à
// l'effacement) : supprime son compte Auth, sa fiche "accounts", et sa
// fiche voyageur ("profiles"/"profilesPrivate") si elle existe. Les
// commandes, messages et points liés à son numéro sont conservés, comme
// pour une suppression faite par l'admin — ils concernent aussi l'autre
// partie (client/voyageur) et servent de justificatif en cas de litige.
exports.deleteMyAccount = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise');
  const uid = request.auth.uid;
  const accountRef = db.collection('accounts').doc(uid);
  const accountSnap = await accountRef.get();
  const phone = accountSnap.exists ? cleanPhone(accountSnap.data().phone) : null;

  await accountRef.delete();

  if (phone) {
    // Le champ "phone" de la fiche accounts est librement modifiable par son
    // propriétaire (les règles Firestore ne vérifient que l'UID, pas le
    // contenu) — on ne le fait donc PAS confiance seul pour choisir quelle
    // fiche voyageur supprimer, sinon un compte pourrait forcer la
    // suppression du profil (et de la pièce d'identité) d'un autre voyageur
    // en déclarant son numéro avant d'appeler cette fonction. On ne supprime
    // profiles/profilesPrivate que si ce numéro correspond au numéro
    // réellement vérifié par SMS sur CE compte (Firebase Phone Auth, que le
    // client ne peut pas falsifier).
    let verifiedPhoneDigits = null;
    try {
      const userRecord = await admin.auth().getUser(uid);
      if (userRecord.phoneNumber) verifiedPhoneDigits = cleanPhone(userRecord.phoneNumber);
    } catch (e) {}
    const localDigits = phone.startsWith('0') ? phone.slice(1) : phone;
    if (verifiedPhoneDigits && localDigits && verifiedPhoneDigits.endsWith(localDigits)) {
      await db.collection('profiles').doc(phone).delete().catch(() => {});
      await db.collection('profilesPrivate').doc(phone).delete().catch(() => {});
    }
  }

  await admin.auth().deleteUser(uid).catch(() => {});

  return { success: true };
});

// Email + notification push au voyageur dès qu'un client lui envoie une
// nouvelle demande. La notification reprend le nom du client en titre,
// comme un message reçu — jamais une bannière générique.
exports.notifyNewOrder = onDocumentCreated({ document: 'orders/{orderId}', secrets: EMAIL_SECRETS, region: REGION }, async (event) => {
  const order = event.data.data();
  if (order.status !== 'pending') return;
  await sendPush(order.gpPhone, {
    title: order.clientName || 'Nouvelle demande',
    body: `souhaite vous confier un colis : ${order.from} → ${order.to} (${order.kg}kg)`,
    tag: `order-${event.params.orderId}`,
  });
  const email = await findEmailByPhone(order.gpPhone);
  if (!email) return;
  await sendEmail(
    email,
    '📦 Nouvelle demande de colis sur Baraka GP',
    `<p>Bonjour,</p>
     <p><b>${order.clientName || 'Un client'}</b> souhaite vous confier un colis sur le trajet
     <b>${order.from} → ${order.to}</b> (${order.kg}kg).</p>
     <p><a href="${APP_URL}">Ouvrir Baraka GP</a> pour accepter ou refuser cette demande.</p>`
  );
});

// Email + notification push au client dès que le voyageur accepte sa demande.
exports.notifyOrderAccepted = onDocumentUpdated({ document: 'orders/{orderId}', secrets: EMAIL_SECRETS, region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status || after.status !== 'accepted') return;
  await sendPush(after.clientPhone, {
    title: after.gpName || 'Demande acceptée',
    body: `a accepté votre demande : ${after.from} → ${after.to}`,
    tag: `order-${event.params.orderId}`,
  });
  const email = await findEmailByPhone(after.clientPhone);
  if (!email) return;
  await sendEmail(
    email,
    '✅ Votre demande a été acceptée !',
    `<p>Bonjour,</p>
     <p><b>${after.gpName || 'Le voyageur'}</b> a accepté votre demande pour le trajet
     <b>${after.from} → ${after.to}</b>.</p>
     <p><a href="${APP_URL}">Ouvrir Baraka GP</a> pour voir le lieu et l'horaire de prise en charge dès qu'il sera proposé.</p>`
  );
});

// Notification push au voyageur dès que le client a payé — il peut
// récupérer le colis au lieu et à l'horaire convenus.
exports.notifyOrderPaid = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status || after.status !== 'paid') return;
  await sendPush(after.gpPhone, {
    title: after.clientName || 'Paiement reçu',
    body: `a payé le colis : ${after.from} → ${after.to}. Vous pouvez le récupérer.`,
    tag: `order-${event.params.orderId}`,
  });
});

// Notification push à l'AUTRE partie dès qu'un lieu et un horaire de prise
// en charge sont proposés — le voyageur peut proposer, mais le client peut
// aussi faire une contre-proposition, donc le destinataire dépend de
// pickupProposedBy (absent/'gp' = proposition du voyageur → prévenir le
// client ; 'client' = contre-proposition → prévenir le voyageur).
exports.notifyPickupProposed = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after.pickupLocation || before.pickupLocation === after.pickupLocation) return;
  if (after.pickupProposedBy === 'client') {
    await sendPush(after.gpPhone, {
      title: after.clientName || 'Lieu de prise en charge proposé',
      body: `propose un autre lieu et horaire de prise en charge pour le colis.`,
      tag: `order-${event.params.orderId}`,
    });
  } else {
    await sendPush(after.clientPhone, {
      title: after.gpName || 'Lieu de prise en charge proposé',
      body: `a proposé un lieu et un horaire de prise en charge pour votre colis.`,
      tag: `order-${event.params.orderId}`,
    });
  }
});

// Notification push à celui qui avait proposé le lieu/horaire, dès que
// l'autre partie l'accepte — avant la contre-proposition, c'était toujours
// le voyageur qui proposait, donc toujours le voyageur qu'on prévenait ;
// pickupProposedBy (sur le document précédent, puisqu'il ne change pas à
// l'acceptation) dit maintenant qui attendait une réponse.
exports.notifyPickupTimeAccepted = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.pickupTimeAccepted || !after.pickupTimeAccepted) return;
  if (before.pickupProposedBy === 'client') {
    await sendPush(after.clientPhone, {
      title: after.gpName || 'Lieu confirmé',
      body: `a accepté le lieu et l'horaire que vous avez proposés.`,
      tag: `order-${event.params.orderId}`,
    });
  } else {
    await sendPush(after.gpPhone, {
      title: after.clientName || 'Lieu confirmé',
      body: `a confirmé le lieu et l'horaire de prise en charge.`,
      tag: `order-${event.params.orderId}`,
    });
  }
});

// Notification push au client dès que le voyageur a récupéré le colis.
exports.notifyPickedUp = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status || after.status !== 'picked_up') return;
  await sendPush(after.clientPhone, {
    title: after.gpName || 'Colis récupéré',
    body: `a récupéré votre colis : ${after.from} → ${after.to}.`,
    tag: `order-${event.params.orderId}`,
  });
});

// Notification push au client dès que la remise au destinataire est confirmée.
exports.notifyDelivered = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status || after.status !== 'delivered') return;
  await sendPush(after.clientPhone, {
    title: 'Colis remis',
    body: `Votre colis a été remis au destinataire : ${after.from} → ${after.to}.`,
    tag: `order-${event.params.orderId}`,
  });
});

// Notification push au voyageur dès que la commande est terminée (son
// versement est déclenché à ce moment-là, voir transferToTraveler).
exports.notifyCompleted = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status || after.status !== 'completed') return;
  await sendPush(after.gpPhone, {
    title: 'Commande terminée',
    body: `Livraison confirmée pour ${after.from} → ${after.to}, votre versement est en cours.`,
    tag: `order-${event.params.orderId}`,
  });
});

// Génère un identifiant Baraka GP (4 caractères) à écrire sur les colis,
// unique parmi les codes déjà attribués — équivalent serveur de genRefCode()
// côté client (index.html), utilisé ici seulement pour créer un nouveau
// document "points" quand il n'en existe pas encore.
async function generateUniqueRefCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const snap = await db.collection('points').where('refCode', '==', code).limit(1).get();
    if (snap.empty) return code;
  }
  throw new Error('Impossible de générer un identifiant unique après 20 tentatives');
}

// Crédite les points de fidélité quand une commande passe à "terminée" :
// +5 au client, et +5 au parrain (une seule fois, à la toute première
// commande terminée du filleul). Fait ici côté serveur (Admin SDK, donc pas
// soumis à firestore.rules) plutôt que par le navigateur du voyageur ou du
// destinataire (anonyme) qui confirme la livraison — ni l'un ni l'autre n'a
// de raison d'avoir le droit d'écrire sur le solde de quelqu'un d'autre.
exports.awardCompletionPoints = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status || after.status !== 'completed') return;
  const clientKey = cleanPhone(after.clientPhone);
  if (!clientKey) return;

  const clientRef = db.collection('points').doc(clientKey);
  let referrerInfo = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(clientRef);
    const data = snap.exists
      ? snap.data()
      : { points: 0, referredBy: null, firstOrderCredited: false, refCode: await generateUniqueRefCode() };
    data.points = (data.points || 0) + 5;
    if (data.referredBy && !data.firstOrderCredited) {
      data.firstOrderCredited = true;
      referrerInfo = data.referredBy;
    }
    tx.set(clientRef, data, { merge: true });
  });

  if (referrerInfo) {
    try {
      const q = await db.collection('points').where('refCode', '==', referrerInfo).limit(1).get();
      if (!q.empty) {
        await db.runTransaction(async (tx) => {
          const refDoc = q.docs[0].ref;
          const snap = await tx.get(refDoc);
          const data = snap.data();
          data.points = (data.points || 0) + 5;
          tx.set(refDoc, data, { merge: true });
        });
      }
    } catch (err) {
      console.error('awardCompletionPoints: échec du crédit parrain pour', referrerInfo, ':', err.message);
    }
  }
});

// Nombre de trajets terminés, affiché sur le profil public d'un voyageur
// (showProfileDetail côté client) — ne peut plus être recalculé en scannant
// toutes les commandes (devenues privées, voir firestore.rules), donc tenu
// à jour ici, au seul moment où une commande devient "terminée".
exports.awardCompletionTripCount = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status || after.status !== 'completed') return;
  const gpKey = cleanPhone(after.gpPhone);
  const ref = db.collection('profiles').doc(gpKey);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return; // un voyageur a nécessairement déjà un profil (billet/identité) pour avoir publié ce trajet
    const data = snap.data();
    data.completedTripsCount = (data.completedTripsCount || 0) + 1;
    tx.set(ref, data, { merge: true });
  });
});

// Reporte une note (voyageur notant son client, ou client notant son
// voyageur) sur le profil public de la personne notée — moyenne, nombre
// d'avis, et une petite copie des derniers commentaires pour le voyageur
// (affichés sur son profil). Fait ici plutôt que par le navigateur de la
// personne qui note, puisque ça touche le profil de quelqu'un d'autre.
exports.applyOrderRating = onDocumentUpdated({ document: 'orders/{orderId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  if (after.rating != null && before.rating == null) {
    const gpKey = cleanPhone(after.gpPhone);
    const ref = db.collection('profiles').doc(gpKey);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : { name: after.gpName || 'Voyageur', phone: after.gpPhone, verified: false, ratingSum: 0, ratingCount: 0 };
      data.ratingSum = (data.ratingSum || 0) + after.rating;
      data.ratingCount = (data.ratingCount || 0) + 1;
      if (after.ratingComment) {
        const reviews = (data.publicReviews || []).slice(0, 4);
        reviews.unshift({ rating: after.rating, comment: after.ratingComment, createdAt: Date.now() });
        data.publicReviews = reviews;
      }
      tx.set(ref, data, { merge: true });
    });
  }

  if (after.clientRating != null && before.clientRating == null) {
    const clientKey = cleanPhone(after.clientPhone);
    const ref = db.collection('profiles').doc(clientKey);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : { name: after.clientName || 'Utilisateur', phone: after.clientPhone, verified: false, ratingSum: 0, ratingCount: 0 };
      data.clientRatingSum = (data.clientRatingSum || 0) + after.clientRating;
      data.clientRatingCount = (data.clientRatingCount || 0) + 1;
      tx.set(ref, data, { merge: true });
    });
  }
});

// Alerte l'admin par email dès qu'un nouveau voyageur publie son premier
// trajet (pièce d'identité en attente de vérification) — évite de compter
// sur une visite régulière d'admin.html pour s'en rendre compte.
exports.notifyAdminNewProfile = onDocumentCreated({ document: 'profiles/{phone}', secrets: EMAIL_SECRETS, region: REGION }, async (event) => {
  const profile = event.data.data();
  if (profile.verified) return;
  await notifyAdmin(
    '🧳 Nouveau voyageur à vérifier sur Baraka GP',
    `<p><b>${profile.name || 'Un voyageur'}</b> vient de publier son premier trajet et attend la vérification de son identité.</p>
     <p><a href="${ADMIN_URL}">Ouvrir l'admin</a> pour vérifier.</p>`
  );
});

// Pareil pour une nouvelle demande de colis (modération de contenu, pas
// d'identité) — voir admin.html / setColisVerified.
exports.notifyAdminNewColisListing = onDocumentCreated({ document: 'listings/{id}', secrets: EMAIL_SECRETS, region: REGION }, async (event) => {
  const listing = event.data.data();
  if (listing.type !== 'colis' || listing.verified) return;
  await notifyAdmin(
    '📦 Nouvelle demande de colis à vérifier sur Baraka GP',
    `<p><b>${listing.name || 'Un client'}</b> a publié une demande d'envoi (${listing.from} → ${listing.to}) qui attend vérification.</p>
     <p><a href="${ADMIN_URL}">Ouvrir l'admin</a> pour vérifier.</p>`
  );
});

// Alerte l'admin dès qu'un virement au voyageur échoue (ex. compte Stripe
// pas configuré) — jusqu'ici visible uniquement en ouvrant admin.html.
exports.notifyAdminTransferIssue = onDocumentUpdated({ document: 'orders/{orderId}', secrets: EMAIL_SECRETS, region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after.transferError || after.transferError === before.transferError) return;
  await notifyAdmin(
    "⚠️ Échec d'un virement voyageur sur Baraka GP",
    `<p>Le virement pour la commande <b>${event.params.orderId}</b> (${after.from} → ${after.to}) a échoué :</p>
     <p>${after.transferError}</p>
     <p><a href="${ADMIN_URL}">Ouvrir l'admin</a> pour vérifier.</p>`
  );
});

// Notification push pour la messagerie support (admin → utilisateur). Pas
// l'inverse : l'admin lit les messages depuis la console, pas via push.
exports.notifyUserMessage = onDocumentUpdated({ document: 'messages/{phone}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const beforeThread = before.thread || [];
  const afterThread = after.thread || [];
  console.log(`notifyUserMessage déclenché pour ${event.params.phone} : ${beforeThread.length} -> ${afterThread.length} messages`);
  if (afterThread.length <= beforeThread.length) return;
  const last = afterThread[afterThread.length - 1];
  if (!last || last.from !== 'admin') { console.log('notifyUserMessage: dernier message pas de l\'admin, ignoré'); return; }
  await sendPush(event.params.phone, {
    title: 'Support Baraka GP',
    body: last.text,
    tag: `support-${event.params.phone}`,
  });
});

// Notification push pour la messagerie de commande : entre client et
// voyageur, et entre client et destinataire (le destinataire, anonyme, ne
// reçoit jamais de push — seul le client peut être notifié de ses messages).
exports.notifyOrderMessage = onDocumentUpdated({ document: 'orderMsgs/{threadId}', region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const beforeThread = before.thread || [];
  const afterThread = after.thread || [];
  if (afterThread.length <= beforeThread.length) return;
  const last = afterThread[afterThread.length - 1];
  if (!last) return;

  const threadId = event.params.threadId;
  const isRecipientThread = threadId.endsWith('_recipient');
  const orderId = isRecipientThread ? threadId.slice(0, -'_recipient'.length) : threadId;
  const orderSnap = await db.collection('orders').doc(orderId).get();
  if (!orderSnap.exists) return;
  const order = orderSnap.data();

  if (isRecipientThread) {
    if (last.from !== 'recipient') return;
    await sendPush(order.clientPhone, {
      title: order.recipientName || 'Destinataire',
      body: last.text,
      tag: `order-${orderId}`,
    });
    return;
  }

  if (last.from === 'client') {
    await sendPush(order.gpPhone, { title: order.clientName || 'Client', body: last.text, tag: `order-${orderId}` });
  } else if (last.from === 'gp') {
    await sendPush(order.clientPhone, { title: order.gpName || 'Voyageur', body: last.text, tag: `order-${orderId}` });
  }
});
