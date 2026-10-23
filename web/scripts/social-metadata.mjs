export const siteDescription = 'Open-source, solar-powered balloon payloads for collecting and sharing data from the stratosphere. Build your own, follow our flights, and join the network.';

// The site card loops the balloon rising away and the next one rising from the clouds. Frame 0 is the still card
// (social-card.jpg), so apps that only show a GIF's first frame look the same; iMessage autoplays the MP4.
const launchImage = {
  src: '/assets/launch/social-card-loop.gif',
  width: 1200,
  height: 630,
  alt: 'The Stratolink wordmark over a Stratolink balloon and its payload above the San Francisco skyline and clouds.',
};
const launchVideo = { src: '/assets/launch/social-card-loop.mp4', width: 1200, height: 630 };
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const absolute = path => new URL(path, 'https://stratolink.org').href;

export function socialMetadata({ title, path, description = siteDescription, image = launchImage, video = image === launchImage ? launchVideo : null, type = 'website' }) {
  const imageUrl = escape(absolute(image.src));
  const imageType = { png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[image.src.split('.').pop()] ?? 'image/jpeg';
  const videoUrl = video && escape(absolute(video.src));
  return `  <meta name="description" content="${escape(description)}">
  <link rel="canonical" href="${escape(absolute(path))}">
  <meta property="og:site_name" content="Stratolink">
  <meta property="og:type" content="${escape(type)}">
  <meta property="og:title" content="${escape(title)}">
  <meta property="og:description" content="${escape(description)}">
  <meta property="og:url" content="${escape(absolute(path))}">
  <meta property="og:image" content="${imageUrl}">
  <meta property="og:image:type" content="${imageType}">
  <meta property="og:image:width" content="${image.width}">
  <meta property="og:image:height" content="${image.height}">
  <meta property="og:image:alt" content="${escape(image.alt)}">${video ? `
  <meta property="og:video" content="${videoUrl}">
  <meta property="og:video:secure_url" content="${videoUrl}">
  <meta property="og:video:type" content="video/mp4">
  <meta property="og:video:width" content="${video.width}">
  <meta property="og:video:height" content="${video.height}">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escape(title)}">
  <meta name="twitter:description" content="${escape(description)}">
  <meta name="twitter:image" content="${imageUrl}">
  <meta name="twitter:image:alt" content="${escape(image.alt)}">`;
}
