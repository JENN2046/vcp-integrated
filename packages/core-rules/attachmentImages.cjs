'use strict';

// Hosts supply their own Sharp runtime. Keep Electron's attachment frame
// selection and JPEG settings usable by a headless model request as well.
async function attachmentImages(sharp, bytes, {
    gif = false, limitInputPixels, maxOutputBytes = Infinity, maxFrames = Infinity,
} = {}) {
    const jpeg = page => sharp(bytes, { page, limitInputPixels })
        .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 }).toBuffer();
    const budgetExceeded = () => Object.assign(new Error('Attachment image budget exceeded'), {
        code: 'ATTACHMENT_REQUEST_BUDGET', status: 413,
    });
    if (maxFrames < 1 || maxOutputBytes < 1) throw budgetExceeded();
    const firstFrame = async () => {
        const frame = await jpeg(0);
        if (frame.length > maxOutputBytes) throw budgetExceeded();
        return { frames: [frame], isGif: false };
    };
    if (!gif) return firstFrame();

    try {
        const metadata = await sharp(bytes, { animated: true }).metadata();
        const count = metadata.pages || 1;
        const frames = [];
        let delay = 0, outputBytes = 0;
        for (let page = 0; page < count; page++) {
            if (page === 0 || delay >= 500) {
                if (frames.length >= maxFrames || outputBytes >= maxOutputBytes) throw budgetExceeded();
                const frame = await jpeg(page);
                outputBytes += frame.length;
                if (outputBytes > maxOutputBytes) throw budgetExceeded();
                frames.push(frame);
                delay = 0;
            }
            if (count > 1) delay += metadata.delay?.[page] > 0 ? metadata.delay[page] : 100;
        }
        return { frames, isGif: true };
    } catch (error) {
        if (error.code === 'ATTACHMENT_REQUEST_BUDGET') throw error;
        return firstFrame();
    }
}

module.exports = { attachmentImages };
