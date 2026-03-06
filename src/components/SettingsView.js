/**
 * SettingsView component for displaying allocator settings
 */
export function createSettingsView(dst, snapshot, device) {
  dst.selectAll('svg').remove();
  dst.selectAll('div').remove();
  const settingsDiv = dst.append('div');
  settingsDiv.append('p').text('Caching Allocator Settings:');

  if ('allocator_settings' in snapshot) {
    settingsDiv
      .append('pre')
      .text(JSON.stringify(snapshot.allocator_settings, null, 2));
  } else {
    settingsDiv.append('p').text('No allocator settings found.');
  }
}
