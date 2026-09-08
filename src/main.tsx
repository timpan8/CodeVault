import { render } from 'preact'
import { App } from '@ui/App'
import './ui/styles.css'

const root = document.getElementById('app')
if (!root) {
  throw new Error('Missing #app root element')
}
render(<App />, root)
