import sharp from 'sharp';
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#F5F2ED"/>
<g transform="translate(256 ${268}) scale(${pad})">
<ellipse cx="0" cy="-118" rx="70" ry="18" fill="#B98680"/>
<path d="M-62 -116 C -62 -80 -120 -50 -120 30 C -120 110 -66 160 0 160 C 66 160 120 110 120 30 C 120 -50 62 -80 62 -116 Z" fill="#C49A94"/>
<path d="M-112 20 C -60 40 60 40 112 20" stroke="#F5F2ED" stroke-width="7" fill="none" opacity=".55"/>
</g></svg>`;
const out = [['icon-192.png',192,1],['icon-512.png',512,1],['icon-maskable-512.png',512,0.78],['apple-touch-icon.png',180,1]];
for (const [f,s,p] of out) await sharp(Buffer.from(svg(p))).resize(s,s).png().toFile('public/'+f);
console.log('ok');
