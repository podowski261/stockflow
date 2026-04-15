# Configuration Supabase Storage pour les images

## Étapes à suivre dans Supabase

### 1. Créer le bucket de stockage
1. Aller dans **Supabase Dashboard** → **Storage**
2. Cliquer **New bucket**
3. Nom : `stockflow-images`
4. Cocher **Public bucket** ✅ (pour que les images soient accessibles publiquement)
5. Cliquer **Save**

### 2. Obtenir les clés API
1. Aller dans **Settings** → **API**
2. Copier :
   - **Project URL** → `SUPABASE_URL`
   - **service_role** (secret) → `SUPABASE_SERVICE_KEY` ⚠️ PAS la clé `anon`

### 3. Configurer les variables d'environnement sur Render
Dans Render → votre service → **Environment** :

```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1...  (service_role key)
SUPABASE_BUCKET=stockflow-images
```

### 4. Politique d'accès (si les images ne s'affichent pas)
Dans Supabase → Storage → `stockflow-images` → **Policies** :
- Ajouter une policy **SELECT** pour `public` :
  ```sql
  true
  ```

## Pourquoi Supabase Storage ?

Render (free tier) a un **filesystem éphémère** : les fichiers uploadés localement
sont supprimés à chaque redémarrage/déploiement. Supabase Storage est persistant et gratuit.
