// ESTRUTURA: ponto de entrada — importa módulos temáticos
import './debug.js';          // logging e informações
import './geometria.js';     // stub
import './pontos.js';        // stub
import './rastreamento.js';  // stub
import './exportacao.js';    // stub
import './matematica.js';    // utilidades
import { openRearCamera } from './visao.js';
import './interface.js';     // interface irá usar visao (import circular evitado)

console.log('estrutura.js carregado — módulos temáticos importados.');

// nenhuma lógica extra aqui — interface.js se encarrega dos handlers de UI
