/**
 * SettingsView component for displaying allocator settings
 */

/**
 * Apply simple JSON syntax highlighting
 */
function highlightJSON(jsonStr) {
  return jsonStr
    // Highlight string keys
    .replace(/"([^"]+)"(?=\s*:)/g, '<span style="color: #8ca4ff">"$1"</span>')
    // Highlight string values
    .replace(/:\s*"([^"]*?)"/g, ': <span style="color: #34d399">"$1"</span>')
    // Highlight booleans
    .replace(/\b(true|false)\b/g, '<span style="color: #fbbf24">$1</span>')
    // Highlight numbers
    .replace(/:\s*(-?\d+\.?\d*)/g, ': <span style="color: #f28e2c">$1</span>')
    // Highlight null
    .replace(/\b(null)\b/g, '<span style="color: #f87171">$1</span>');
}

export function createSettingsView(dst, snapshot, device) {
  dst.selectAll('svg').remove();
  dst.selectAll('div').remove();
  const settingsDiv = dst.append('div').attr('class', 'settings-view');
  const card = settingsDiv.append('div').attr('class', 'settings-card');
  card.append('div').attr('class', 'settings-card-title').text('Caching Allocator Settings');

  if ('allocator_settings' in snapshot) {
    const settings = snapshot.allocator_settings;

    // Show environment variable badge if present
    if (settings.PYTORCH_CUDA_ALLOC_CONF) {
      const envBadge = card.append('div')
        .style('display', 'inline-flex')
        .style('align-items', 'center')
        .style('gap', '6px')
        .style('margin-bottom', '14px')
        .style('padding', '6px 12px')
        .style('background', 'rgba(108, 140, 255, 0.1)')
        .style('border', '1px solid rgba(108, 140, 255, 0.25)')
        .style('border-radius', '6px')
        .style('font-size', '12px')
        .style('font-family', "'JetBrains Mono', 'SF Mono', monospace");
      envBadge.append('span')
        .style('color', '#6c8cff')
        .style('font-weight', '600')
        .text('ENV');
      envBadge.append('span')
        .style('color', '#9aa0b0')
        .text('PYTORCH_CUDA_ALLOC_CONF = ');
      envBadge.append('span')
        .style('color', '#34d399')
        .text(settings.PYTORCH_CUDA_ALLOC_CONF);
    }

    const jsonStr = JSON.stringify(settings, null, 2);
    card
      .append('pre')
      .html(highlightJSON(jsonStr));
  } else {
    card.append('p').attr('class', 'settings-empty').text('No allocator settings found.');
  }
}
