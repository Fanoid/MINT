/**
 * SettingsView component for displaying allocator settings
 */
export function createSettingsView(dst, snapshot, device) {
  dst.selectAll('svg').remove();
  dst.selectAll('div').remove();
  const settingsDiv = dst.append('div').attr('class', 'settings-view');
  const card = settingsDiv.append('div').attr('class', 'settings-card');
  card.append('div').attr('class', 'settings-card-title').text('Caching Allocator Settings');

  if ('allocator_settings' in snapshot) {
    card
      .append('pre')
      .text(JSON.stringify(snapshot.allocator_settings, null, 2));
  } else {
    card.append('p').attr('class', 'settings-empty').text('No allocator settings found.');
  }
}
