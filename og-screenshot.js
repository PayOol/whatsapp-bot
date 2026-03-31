/**
 * 📸 OG Image Generator - Capture automatique du landing page
 * Génère og-image.png pour les previews SEO (Open Graph / Twitter Cards)
 * Fonctionne comme Lighthouse avec Puppeteer
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Configuration
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
const OUTPUT_PATH = path.join(__dirname, 'public', 'og-image.png');
const LANDING_URL = process.env.LANDING_URL || `http://localhost:${process.env.PORT || 3000}/landing.html`;

// Options de capture
const CAPTURE_OPTIONS = {
    viewport: { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT },
    fullPage: false,
    omitBackground: false,
    type: 'jpeg',
    quality: 85, // Compression JPEG pour réduire la taille
    encoding: 'binary'
};

/**
 * Capture le landing page et génère l'image OG
 * @param {string} url - URL du landing page
 * @param {boolean} headless - Mode headless (défaut: true)
 * @returns {Promise<string>} - Chemin de l'image générée
 */
async function captureLandingPage(url = LANDING_URL, headless = true) {
    let browser = null;
    
    try {
        console.log(`📸 Capture OG Image...`);
        console.log(`   URL: ${url}`);
        console.log(`   Dimensions: ${OG_IMAGE_WIDTH}x${OG_IMAGE_HEIGHT}`);
        
        // Lancer le navigateur
        browser = await puppeteer.launch({
            headless: headless ? 'new' : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1200,630'
            ]
        });
        
        const page = await browser.newPage();
        
        // Configurer la viewport
        await page.setViewport({
            width: OG_IMAGE_WIDTH,
            height: OG_IMAGE_HEIGHT,
            deviceScaleFactor: 1 // Facteur 1 pour réduire la taille (au lieu de 2)
        });
        
        // Naviguer vers le landing page
        console.log(`   Navigation...`);
        await page.goto(url, {
            waitUntil: ['networkidle0', 'domcontentloaded'],
            timeout: 30000
        });
        
        // Attendre que les polices et images soient chargées
        await page.evaluateHandle('document.fonts.ready');
        
        // Attendre un peu pour les animations CSS
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Masquer les éléments interactifs/animés pour une image statique
        await page.evaluate(() => {
            // Supprimer les animations pour la capture
            const style = document.createElement('style');
            style.textContent = `
                *, *::before, *::after {
                    animation-duration: 0s !important;
                    animation-delay: 0s !important;
                    transition-duration: 0s !important;
                }
                .whatsapp-float { display: none !important; }
                .skip-link { display: none !important; }
            `;
            document.head.appendChild(style);
            
            // Forcer le thème light pour une meilleure apparence
            document.body.setAttribute('data-theme', 'light');
        });
        
        // Attendre que les styles soient appliqués
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Capturer la page en JPEG pour réduire la taille
        console.log(`   Capture...`);
        const screenshot = await page.screenshot({
            type: 'jpeg',
            quality: 80,
            fullPage: false,
            clip: {
                x: 0,
                y: 0,
                width: OG_IMAGE_WIDTH,
                height: OG_IMAGE_HEIGHT
            }
        });
        
        // Sauvegarder l'image
        const dir = path.dirname(OUTPUT_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(OUTPUT_PATH, screenshot);
        
        const fileSize = (screenshot.length / 1024).toFixed(2);
        console.log(`✅ Image générée: ${OUTPUT_PATH}`);
        console.log(`   Taille: ${fileSize} KB`);
        
        return OUTPUT_PATH;
        
    } catch (error) {
        console.error(`❌ Erreur capture: ${error.message}`);
        throw error;
        
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

/**
 * Vérifie si l'image OG existe et est récente
 * @param {number} maxAgeHours - Âge maximum en heures (défaut: 24)
 * @returns {boolean} - True si l'image est valide
 */
function isOgImageValid(maxAgeHours = 24) {
    if (!fs.existsSync(OUTPUT_PATH)) {
        return false;
    }
    
    const stats = fs.statSync(OUTPUT_PATH);
    const ageMs = Date.now() - stats.mtimeMs;
    const ageHours = ageMs / (1000 * 60 * 60);
    
    return ageHours < maxAgeHours;
}

/**
 * Génère l'image OG si nécessaire
 * @param {boolean} force - Forcer la régénération
 */
async function ensureOgImage(force = false) {
    if (force || !isOgImageValid()) {
        console.log('📸 Régénération de l\'image OG...');
        await captureLandingPage();
    } else {
        console.log('📸 Image OG existante et valide');
    }
}

// CLI - Exécution directe
if (require.main === module) {
    const args = process.argv.slice(2);
    const force = args.includes('--force') || args.includes('-f');
    const url = args.find(a => !a.startsWith('-')) || LANDING_URL;
    
    captureLandingPage(url)
        .then(() => {
            console.log('✅ Terminé');
            process.exit(0);
        })
        .catch((err) => {
            console.error('❌ Échec:', err.message);
            process.exit(1);
        });
}

module.exports = {
    captureLandingPage,
    ensureOgImage,
    isOgImageValid,
    OG_IMAGE_WIDTH,
    OG_IMAGE_HEIGHT,
    OUTPUT_PATH
};
