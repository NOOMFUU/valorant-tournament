const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

const tailwindMap = {
    'text-[9px]': 'text-[10px]',
    'text-[10px]': 'text-xs',
    'text-xs': 'text-sm',
    'text-sm': 'text-base',
    'text-base': 'text-lg',
    'text-lg': 'text-xl',
    'text-xl': 'text-2xl',
    'text-2xl': 'text-3xl',
    'text-3xl': 'text-4xl',
    'text-4xl': 'text-5xl',
    'text-5xl': 'text-6xl',
    'text-6xl': 'text-7xl'
};

files.forEach(file => {
    let content = fs.readFileSync(path.join(publicDir, file), 'utf8');

    // CSS blocks replacements
    content = content.replace(/body\s*\{[\s\S]*?\}/, `body { background-color: #0f1923; color: #ece8e1; font-family: 'Rajdhani', sans-serif; font-size: 1.125rem; font-weight: 500; }`);
    content = content.replace(/\.font-header\s*\{[\s\S]*?\}/, `.font-header { font-family: 'Oswald', sans-serif; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }`);
    content = content.replace(/\.font-mono\s*\{[\s\S]*?\}/, `.font-mono { font-family: 'Courier New', monospace; letter-spacing: 0.05em; }`);
    
    // Specifically for index.html and other specific elements sizes
    content = content.replace(/\.hero-title\s*\{[\s\S]*?\}/, `.hero-title {
            font-family: 'Oswald', sans-serif;
            font-size: clamp(5rem, 15vw, 12rem);
            font-weight: 700;
            line-height: 0.85;
            text-transform: uppercase;
            letter-spacing: 0.02em;
            text-shadow: 6px 6px 0px rgba(255, 70, 85, 0.2);
        }`);

    content = content.replace(/\.stat-value\s*\{[\s\S]*?\}/, `.stat-value {
            font-family: 'Oswald', sans-serif;
            font-size: 4.5rem;
            font-weight: 700;
            line-height: 1;
            color: #ff4655;
            letter-spacing: 0.05em;
        }`);
        
    content = content.replace(/\.stat-label\s*\{[\s\S]*?\}/, `.stat-label {
            font-family: 'Rajdhani', sans-serif;
            font-size: 0.95rem;
            text-transform: uppercase;
            font-weight: 700;
            color: #8b978f;
            letter-spacing: 0.1em;
            margin-top: 0.5rem;
        }`);

    content = content.replace(/\.nav-tab\s*\{[\s\S]*?\}/, `.nav-tab {
            padding: 16px 32px;
            font-family: 'Oswald', sans-serif;
            font-weight: 700;
            color: #8b978f;
            border-bottom: 4px solid transparent;
            transition: all 0.2s;
            text-transform: uppercase;
            text-decoration: none;
            letter-spacing: 0.1em; 
            font-size: 1.25rem;
        }`);

    // Increase Google Fonts import weights if needed
    content = content.replace(/family=Oswald:wght@400;500;600;700/g, 'family=Oswald:wght@400;500;600;700;800');

    // Process Tailwind text sizing safely using regex with lookarounds to prevent false positives
    const words = content.split(/([\s"'<>])/);
    for (let i = 0; i < words.length; i++) {
        if (tailwindMap[words[i]]) {
            words[i] = tailwindMap[words[i]];
        }
    }
    content = words.join('');

    fs.writeFileSync(path.join(publicDir, file), content, 'utf8');
});
console.log('Typography updated successfully in all HTML files.');