# baraka-gp

Application de mise en relation entre particuliers pour l'envoi de colis via des
voyageurs.

- `index.html` — l'application publique (recherche, envoi de colis, publier un
  trajet, commandes, points, support).
- `admin.html` — la console d'administration (vérifier les identités et les
  annonces, gérer les litiges, répondre au support). Page séparée, non liée
  depuis `index.html` : seule une personne connaissant son URL peut la trouver,
  et il faut ensuite un compte admin pour y entrer.

## Configuration Firebase

Les données (annonces, commandes, profils, points, messages) sont stockées dans
Firebase Firestore et partagées entre tous les utilisateurs. `index.html` et
`admin.html` doivent pointer vers le **même** projet Firebase.

1. Créez un projet sur https://console.firebase.google.com.
2. **Build → Firestore Database → Créer une base de données.**
3. **Paramètres du projet (⚙️) → Vos applications → Ajouter une application Web**,
   copiez l'objet `firebaseConfig` et collez-le à la fois dans `index.html` et
   dans `admin.html` (variable `firebaseConfig`, en haut du `<script>`
   principal de chaque fichier) à la place des valeurs `REMPLACER...`.
4. **Build → Authentication → Sign-in method → activez « Email/Mot de passe »**.
   C'est le même système de connexion que les utilisateurs normaux de
   `index.html` (inscription libre, prénom + numéro + email + mot de passe) —
   il faut donc explicitement marquer certains comptes comme admin (étape 6).
   Activez aussi **« Anonyme »** dans la même page : c'est ce qui permet au
   destinataire d'un colis (qui n'a pas de compte Baraka GP) de confirmer sa
   réception via le lien reçu du voyageur, sans avoir à s'inscrire. Sans ça,
   le lien de confirmation de réception (`?receive=...`) reste bloqué.
5. Déployez les règles de sécurité (`firestore.rules`) avec la
   [CLI Firebase](https://firebase.google.com/docs/cli), ou collez le contenu
   du fichier dans **Firestore Database → Règles → Publier** :
   ```
   npm install -g firebase-tools
   firebase login
   firebase use --add        # sélectionnez votre projet
   firebase deploy --only firestore:rules
   ```
6. **Déclarer un compte admin** : le compte propriétaire du projet est reconnu
   directement par son **UID**, codé en dur dans `firestore.rules`
   (`isAdmin()`) et dans `admin.html` (`OWNER_UID`) — pas besoin de créer quoi
   que ce soit dans la console Firebase pour ce compte-là. Pour changer ce
   compte ou en ajouter un autre : dans **Authentication → Users**, copiez le
   **User UID** du compte voulu (icône 📋 à côté de la ligne), puis :
   - soit remplacez la valeur dans les deux fichiers (`OWNER_UID` dans
     `admin.html`, et la valeur correspondante dans `isAdmin()` de
     `firestore.rules`) et republiez les règles ;
   - soit, pour un admin supplémentaire sans toucher au code, allez dans
     **Firestore Database → Données → Commencer une collection**, nommez-la
     `admins`, et créez un document dont l'**ID est exactement cet UID**
     (le contenu importe peu, un champ `role: "admin"` suffit) — c'est le
     mécanisme de secours que `isAdmin()` vérifie en plus de l'UID codé en dur.
   Sans l'un ou l'autre, le compte peut se connecter à `admin.html` mais
   aucune action (vérifier, supprimer) ne fonctionnera : les règles Firestore
   les refuseront silencieusement.

Si vous hébergez le site (Firebase Hosting ou autre), pensez à ne pas mettre de
lien vers `admin.html` nulle part dans le site public ni dans vos moteurs de
recherche (le fichier envoie déjà `<meta name="robots" content="noindex">`) —
son URL doit rester connue de vous seul.

### Limite connue

La pièce d'identité (photo) d'un voyageur est stockée à part, dans la
collection `profilesPrivate`, lisible uniquement par l'admin — elle n'est
plus accessible aux autres utilisateurs connectés comme l'était auparavant
le reste du profil. Les limites ci-dessous concernent le reste des données
(`orders`, `messages`, `points`, et les champs non sensibles de `profiles`).

Un compte (email + mot de passe) est obligatoire pour utiliser `index.html`,
et le numéro de téléphone est désormais vérifié par SMS (Firebase Phone
Auth) juste après l'inscription. Les règles Firestore exigent qu'on soit
connecté pour lire ou écrire quoi que ce soit.

**Commandes (`orders`) et leurs messages (`orderMsgs`) : corrigé.** Ce n'est
plus "connecté = accès à tout" : l'app ne télécharge et ne peut écrire que
les commandes où on est le client ou le voyageur (deux requêtes Firestore
`where`, voir `fetchMyOrders()`), et les règles (`firestore.rules`) refusent
désormais côté serveur toute lecture en liste ou écriture sur la commande de
quelqu'un d'autre. Seule exception, volontaire : le lien de confirmation de
réception (compte anonyme, voir plus bas) peut lire une commande précise par
son id et la faire passer de "livrée" à "terminée", rien d'autre.

Les autres collections (`messages`, `points`, et les champs non sensibles de
`profiles`) n'ont pas encore ce traitement : un compte connecté peut toujours
lire/écrire au-delà de ses propres données sur celles-ci (ça nécessiterait
le même travail — lier chaque enregistrement à son auteur — prévu dans un
prochain passage).

Le lien de confirmation de réception (`?receive=...`) est protégé par le code
à 4 chiffres à saisir, pas par le lien lui-même : toute personne qui devine ou
intercepte le lien ET le code pourrait valider une réception à la place du
vrai destinataire. C'est le même niveau de sécurité que le code de remise
utilisé plus tôt dans le parcours, pas un vrai contrôle d'identité.

Le blocage d'un numéro par l'admin (collection `blockedPhones`) échoue de
façon permissive : si la vérification Firestore échoue au moment de
l'inscription/connexion (réseau instable, service indisponible), la personne
n'est pas bloquée par erreur — mieux vaut laisser passer une fois de trop
que bloquer tout le monde pendant une panne. Un compte bloqué pendant qu'il
est déjà connecté est maintenant éjecté en temps réel (vérifié à chaque
cycle de rafraîchissement, pas seulement à la connexion).

La collection `points` (solde de fidélité de chacun) est, comme le reste,
seulement protégée par « il faut être connecté » — n'importe quel compte
signé (y compris une session anonyme, utilisée pour la confirmation de
réception) peut en théorie écrire directement n'importe quelle valeur sur le
solde de n'importe qui via la console Firebase ou l'API, sans passer par
l'app. Ce n'est pas un oubli isolé : le parrainage et le crédit de points à la
livraison ont volontairement besoin d'écrire depuis le navigateur d'une
personne sur le compte d'une autre (le parrain, le client), donc une règle
"chacun ne modifie que son propre solde" casserait ces fonctionnalités. Une
vraie protection demanderait qu'un serveur de confiance (Cloud Functions,
formule Blaze) valide et applique lui-même les crédits de points, plutôt que
de laisser chaque navigateur écrire directement dans la base.